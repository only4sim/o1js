import { Test } from '../snarky.js';
import { Field } from './core.js';
import { UInt32, UInt64 } from './int.js';
import { PublicKey } from './signature.js';
import { ZkappCommand, TokenId, Authorization } from './account-update.js';
import * as Fetch from './fetch.js';
import { invalidTransactionError } from './mina/errors.js';
import { Types } from '../bindings/mina-transaction/types.js';
import { Account } from './mina/account.js';
import { NetworkId } from '../mina-signer/src/types.js';
import { currentTransaction } from './mina/transaction-context.js';
import {
  type FeePayerSpec,
  type DeprecatedFeePayerSpec,
  type ActionStates,
  type NetworkConstants,
  activeInstance,
  setActiveInstance,
  Mina,
  defaultNetworkConstants,
  currentSlot,
  getAccount,
  hasAccount,
  getBalance,
  getNetworkId,
  getNetworkConstants,
  getNetworkState,
  accountCreationFee,
  fetchEvents,
  fetchActions,
  getActions,
  getProofsEnabled,
} from './mina/mina-instance.js';
import { type EventActionFilterOptions } from './mina/graphql.js';
import {
  type Transaction,
  type PendingTransaction,
  type IncludedTransaction,
  type RejectedTransaction,
  createTransaction,
  newTransaction,
  transaction,
  createIncludedOrRejectedTransaction,
} from './mina/transaction.js';
import {
  reportGetAccountError,
  verifyTransactionLimits,
  defaultNetworkState,
  filterGroups,
} from './mina/transaction-validation.js';
import { LocalBlockchain } from './mina/local-blockchain.js';

export {
  BerkeleyQANet,
  LocalBlockchain,
  Network,
  currentTransaction,
  Transaction,
  PendingTransaction,
  IncludedTransaction,
  RejectedTransaction,
  activeInstance,
  setActiveInstance,
  transaction,
  sender,
  currentSlot,
  getAccount,
  hasAccount,
  getBalance,
  getNetworkId,
  getNetworkConstants,
  getNetworkState,
  accountCreationFee,
  fetchEvents,
  fetchActions,
  getActions,
  FeePayerSpec,
  ActionStates,
  faucet,
  waitForFunding,
  getProofsEnabled,
  // for internal testing only
  filterGroups,
  type NetworkConstants,
};

// patch active instance so that we can still create basic transactions without giving Mina network details
setActiveInstance({
  ...activeInstance,
  async transaction(sender: DeprecatedFeePayerSpec, f: () => void) {
    return createTransaction(sender, f, 0);
  },
});

const Transaction = {
  fromJSON(json: Types.Json.ZkappCommand): Transaction {
    let transaction = ZkappCommand.fromJSON(json);
    return newTransaction(transaction, activeInstance.proofsEnabled);
  },
};

/**
 * Represents the Mina blockchain running on a real network
 */
function Network(graphqlEndpoint: string): Mina;
function Network(options: {
  networkId?: NetworkId;
  mina: string | string[];
  archive?: string | string[];
  lightnetAccountManager?: string;
}): Mina;
function Network(
  options:
    | {
        networkId?: NetworkId;
        mina: string | string[];
        archive?: string | string[];
        lightnetAccountManager?: string;
      }
    | string
): Mina {
  let minaNetworkId: NetworkId = 'testnet';
  let minaGraphqlEndpoint: string;
  let archiveEndpoint: string;
  let lightnetAccountManagerEndpoint: string;

  if (options && typeof options === 'string') {
    minaGraphqlEndpoint = options;
    Fetch.setGraphqlEndpoint(minaGraphqlEndpoint);
  } else if (options && typeof options === 'object') {
    if (options.networkId) {
      minaNetworkId = options.networkId;
    }
    if (!options.mina)
      throw new Error(
        "Network: malformed input. Please provide an object with 'mina' endpoint."
      );
    if (Array.isArray(options.mina) && options.mina.length !== 0) {
      minaGraphqlEndpoint = options.mina[0];
      Fetch.setGraphqlEndpoint(minaGraphqlEndpoint);
      Fetch.setMinaGraphqlFallbackEndpoints(options.mina.slice(1));
    } else if (typeof options.mina === 'string') {
      minaGraphqlEndpoint = options.mina;
      Fetch.setGraphqlEndpoint(minaGraphqlEndpoint);
    }

    if (options.archive !== undefined) {
      if (Array.isArray(options.archive) && options.archive.length !== 0) {
        archiveEndpoint = options.archive[0];
        Fetch.setArchiveGraphqlEndpoint(archiveEndpoint);
        Fetch.setArchiveGraphqlFallbackEndpoints(options.archive.slice(1));
      } else if (typeof options.archive === 'string') {
        archiveEndpoint = options.archive;
        Fetch.setArchiveGraphqlEndpoint(archiveEndpoint);
      }
    }

    if (
      options.lightnetAccountManager !== undefined &&
      typeof options.lightnetAccountManager === 'string'
    ) {
      lightnetAccountManagerEndpoint = options.lightnetAccountManager;
      Fetch.setLightnetAccountManagerEndpoint(lightnetAccountManagerEndpoint);
    }
  } else {
    throw new Error(
      "Network: malformed input. Please provide a string or an object with 'mina' and 'archive' endpoints."
    );
  }

  return {
    getNetworkId: () => minaNetworkId,
    /**
     * @deprecated use {@link Mina.getNetworkConstants}
     */
    accountCreationFee: () => defaultNetworkConstants.accountCreationFee,
    getNetworkConstants() {
      if (currentTransaction()?.fetchMode === 'test') {
        Fetch.markNetworkToBeFetched(minaGraphqlEndpoint);
        const genesisConstants =
          Fetch.getCachedGenesisConstants(minaGraphqlEndpoint);
        return genesisConstants !== undefined
          ? genesisToNetworkConstants(genesisConstants)
          : defaultNetworkConstants;
      }
      if (
        !currentTransaction.has() ||
        currentTransaction.get().fetchMode === 'cached'
      ) {
        const genesisConstants =
          Fetch.getCachedGenesisConstants(minaGraphqlEndpoint);
        if (genesisConstants !== undefined)
          return genesisToNetworkConstants(genesisConstants);
      }
      return defaultNetworkConstants;
    },
    currentSlot() {
      throw Error(
        'currentSlot() is not implemented yet for remote blockchains.'
      );
    },
    hasAccount(publicKey: PublicKey, tokenId: Field = TokenId.default) {
      if (
        !currentTransaction.has() ||
        currentTransaction.get().fetchMode === 'cached'
      ) {
        return !!Fetch.getCachedAccount(
          publicKey,
          tokenId,
          minaGraphqlEndpoint
        );
      }
      return false;
    },
    getAccount(publicKey: PublicKey, tokenId: Field = TokenId.default) {
      if (currentTransaction()?.fetchMode === 'test') {
        Fetch.markAccountToBeFetched(publicKey, tokenId, minaGraphqlEndpoint);
        let account = Fetch.getCachedAccount(
          publicKey,
          tokenId,
          minaGraphqlEndpoint
        );
        return account ?? dummyAccount(publicKey);
      }
      if (
        !currentTransaction.has() ||
        currentTransaction.get().fetchMode === 'cached'
      ) {
        let account = Fetch.getCachedAccount(
          publicKey,
          tokenId,
          minaGraphqlEndpoint
        );
        if (account !== undefined) return account;
      }
      throw Error(
        `${reportGetAccountError(
          publicKey.toBase58(),
          TokenId.toBase58(tokenId)
        )}\nGraphql endpoint: ${minaGraphqlEndpoint}`
      );
    },
    getNetworkState() {
      if (currentTransaction()?.fetchMode === 'test') {
        Fetch.markNetworkToBeFetched(minaGraphqlEndpoint);
        let network = Fetch.getCachedNetwork(minaGraphqlEndpoint);
        return network ?? defaultNetworkState();
      }
      if (
        !currentTransaction.has() ||
        currentTransaction.get().fetchMode === 'cached'
      ) {
        let network = Fetch.getCachedNetwork(minaGraphqlEndpoint);
        if (network !== undefined) return network;
      }
      throw Error(
        `getNetworkState: Could not fetch network state from graphql endpoint ${minaGraphqlEndpoint} outside of a transaction.`
      );
    },
    async sendTransaction(txn: Transaction): Promise<PendingTransaction> {
      txn.sign();

      verifyTransactionLimits(txn.transaction);

      let [response, error] = await Fetch.sendZkapp(txn.toJSON());
      let errors: string[] = [];
      if (response === undefined && error !== undefined) {
        errors = [JSON.stringify(error)];
      } else if (response && response.errors && response.errors.length > 0) {
        response?.errors.forEach((e: any) => errors.push(JSON.stringify(e)));
      }

      const isSuccess = errors.length === 0;
      const hash = Test.transactionHash.hashZkAppCommand(txn.toJSON());
      const pendingTransaction: Omit<
        PendingTransaction,
        'wait' | 'waitOrThrowIfError'
      > = {
        isSuccess,
        data: response?.data,
        errors,
        transaction: txn.transaction,
        hash,
        toJSON: txn.toJSON,
        toPretty: txn.toPretty,
      };

      const pollTransactionStatus = async (
        transactionHash: string,
        maxAttempts: number,
        interval: number,
        attempts: number = 0
      ): Promise<IncludedTransaction | RejectedTransaction> => {
        let res: Awaited<ReturnType<typeof Fetch.checkZkappTransaction>>;
        try {
          res = await Fetch.checkZkappTransaction(transactionHash);
          if (res.success) {
            return createIncludedOrRejectedTransaction(pendingTransaction, []);
          } else if (res.failureReason) {
            const error = invalidTransactionError(
              txn.transaction,
              res.failureReason,
              {
                accountCreationFee:
                  defaultNetworkConstants.accountCreationFee.toString(),
              }
            );
            return createIncludedOrRejectedTransaction(pendingTransaction, [
              error,
            ]);
          }
        } catch (error) {
          return createIncludedOrRejectedTransaction(pendingTransaction, [
            (error as Error).message,
          ]);
        }

        if (maxAttempts && attempts >= maxAttempts) {
          return createIncludedOrRejectedTransaction(pendingTransaction, [
            `Exceeded max attempts.\nTransactionId: ${transactionHash}\nAttempts: ${attempts}\nLast received status: ${res}`,
          ]);
        }

        await new Promise((resolve) => setTimeout(resolve, interval));
        return pollTransactionStatus(
          transactionHash,
          maxAttempts,
          interval,
          attempts + 1
        );
      };

      const wait = async (options?: {
        maxAttempts?: number;
        interval?: number;
      }): Promise<IncludedTransaction | RejectedTransaction> => {
        if (!isSuccess) {
          return createIncludedOrRejectedTransaction(
            pendingTransaction,
            pendingTransaction.errors
          );
        }

        // default is 45 attempts * 20s each = 15min
        // the block time on berkeley is currently longer than the average 3-4min, so its better to target a higher block time
        // fetching an update every 20s is more than enough with a current block time of 3min
        const maxAttempts = options?.maxAttempts ?? 45;
        const interval = options?.interval ?? 20000;
        return pollTransactionStatus(
          pendingTransaction.hash,
          maxAttempts,
          interval
        );
      };

      const waitOrThrowIfError = async (options?: {
        maxAttempts?: number;
        interval?: number;
      }): Promise<IncludedTransaction | RejectedTransaction> => {
        const pendingTransaction = await wait(options);
        if (pendingTransaction.status === 'rejected') {
          throw Error(
            `Transaction failed with errors:\n${pendingTransaction.errors.join(
              '\n'
            )}`
          );
        }
        return pendingTransaction;
      };

      return {
        ...pendingTransaction,
        wait,
        waitOrThrowIfError,
      };
    },
    async transaction(sender: DeprecatedFeePayerSpec, f: () => void) {
      let tx = createTransaction(sender, f, 0, {
        fetchMode: 'test',
        isFinalRunOutsideCircuit: false,
      });
      await Fetch.fetchMissingData(minaGraphqlEndpoint, archiveEndpoint);
      let hasProofs = tx.transaction.accountUpdates.some(
        Authorization.hasLazyProof
      );
      return createTransaction(sender, f, 1, {
        fetchMode: 'cached',
        isFinalRunOutsideCircuit: !hasProofs,
      });
    },
    async fetchEvents(
      publicKey: PublicKey,
      tokenId: Field = TokenId.default,
      filterOptions: EventActionFilterOptions = {}
    ) {
      let pubKey = publicKey.toBase58();
      let token = TokenId.toBase58(tokenId);

      return Fetch.fetchEvents(
        { publicKey: pubKey, tokenId: token },
        archiveEndpoint,
        filterOptions
      );
    },
    async fetchActions(
      publicKey: PublicKey,
      actionStates?: ActionStates,
      tokenId: Field = TokenId.default
    ) {
      let pubKey = publicKey.toBase58();
      let token = TokenId.toBase58(tokenId);
      let { fromActionState, endActionState } = actionStates ?? {};
      let fromActionStateBase58 = fromActionState
        ? fromActionState.toString()
        : undefined;
      let endActionStateBase58 = endActionState
        ? endActionState.toString()
        : undefined;

      return Fetch.fetchActions(
        {
          publicKey: pubKey,
          actionStates: {
            fromActionState: fromActionStateBase58,
            endActionState: endActionStateBase58,
          },
          tokenId: token,
        },
        archiveEndpoint
      );
    },
    getActions(
      publicKey: PublicKey,
      actionStates?: ActionStates,
      tokenId: Field = TokenId.default
    ) {
      if (currentTransaction()?.fetchMode === 'test') {
        Fetch.markActionsToBeFetched(
          publicKey,
          tokenId,
          archiveEndpoint,
          actionStates
        );
        let actions = Fetch.getCachedActions(publicKey, tokenId);
        return actions ?? [];
      }
      if (
        !currentTransaction.has() ||
        currentTransaction.get().fetchMode === 'cached'
      ) {
        let actions = Fetch.getCachedActions(publicKey, tokenId);
        if (actions !== undefined) return actions;
      }
      throw Error(
        `getActions: Could not find actions for the public key ${publicKey}`
      );
    },
    proofsEnabled: true,
  };
}

/**
 *
 * @deprecated This is deprecated in favor of {@link Mina.Network}, which is exactly the same function.
 * The name `BerkeleyQANet` was misleading because it suggested that this is specific to a particular network.
 */
function BerkeleyQANet(graphqlEndpoint: string) {
  return Network(graphqlEndpoint);
}

/**
 * Returns the public key of the current transaction's sender account.
 *
 * Throws an error if not inside a transaction, or the sender wasn't passed in.
 */
function sender() {
  let tx = currentTransaction();
  if (tx === undefined)
    throw Error(
      `The sender is not available outside a transaction. Make sure you only use it within \`Mina.transaction\` blocks or smart contract methods.`
    );
  let sender = currentTransaction()?.sender;
  if (sender === undefined)
    throw Error(
      `The sender is not available, because the transaction block was created without the optional \`sender\` argument.
Here's an example for how to pass in the sender and make it available:

Mina.transaction(sender, // <-- pass in sender's public key here
() => {
  // methods can use this.sender
});
`
    );
  return sender;
}

function dummyAccount(pubkey?: PublicKey): Account {
  let dummy = Types.Account.empty();
  if (pubkey) dummy.publicKey = pubkey;
  return dummy;
}

async function waitForFunding(address: string): Promise<void> {
  let attempts = 0;
  let maxAttempts = 30;
  let interval = 30000;
  const executePoll = async (
    resolve: () => void,
    reject: (err: Error) => void | Error
  ) => {
    let { account } = await Fetch.fetchAccount({ publicKey: address });
    attempts++;
    if (account) {
      return resolve();
    } else if (maxAttempts && attempts === maxAttempts) {
      return reject(new Error(`Exceeded max attempts`));
    } else {
      setTimeout(executePoll, interval, resolve, reject);
    }
  };
  return new Promise(executePoll);
}

/**
 * Requests the [testnet faucet](https://faucet.minaprotocol.com/api/v1/faucet) to fund a public key.
 */
async function faucet(pub: PublicKey, network: string = 'berkeley-qanet') {
  let address = pub.toBase58();
  let response = await fetch('https://faucet.minaprotocol.com/api/v1/faucet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network,
      address: address,
    }),
  });
  response = await response.json();
  if (response.status.toString() !== 'success') {
    throw new Error(
      `Error funding account ${address}, got response status: ${response.status}, text: ${response.statusText}`
    );
  }
  await waitForFunding(address);
}

function genesisToNetworkConstants(
  genesisConstants: Fetch.GenesisConstants
): NetworkConstants {
  return {
    genesisTimestamp: UInt64.from(
      Date.parse(genesisConstants.genesisTimestamp)
    ),
    slotTime: UInt64.from(genesisConstants.slotDuration),
    accountCreationFee: UInt64.from(genesisConstants.accountCreationFee),
  };
}
