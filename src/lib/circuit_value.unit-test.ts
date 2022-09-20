import { Circuit, Field, isReady, shutdown } from '../snarky.js';
import { circuitValue, circuitValueClass } from './circuit_value.js';
import { UInt32 } from './int.js';
import { PrivateKey, PublicKey } from './signature.js';
import { expect } from 'expect';
import { method, SmartContract } from './zkapp.js';
import { LocalBlockchain, setActiveInstance, transaction } from './mina.js';

await isReady;

let type = circuitValue({
  nested: { a: Number, b: undefined },
  other: String,
  pk: PublicKey,
  uint: [UInt32, UInt32],
});

let value = {
  nested: { a: 1, b: undefined },
  other: 'arbitrary data!!!',
  pk: PublicKey.empty(),
  uint: [UInt32.one, UInt32.from(2)],
};
let original = JSON.stringify(value);

// sizeInFields
expect(type.sizeInFields()).toEqual(4);

// toFields
// note that alphabetical order of keys determines ordering here and elsewhere
let fields = type.toFields(value);
expect(fields).toEqual([Field.zero, Field.zero, Field.one, Field(2)]);

// toAuxiliary
let aux = type.toAuxiliary(value);
expect(aux).toEqual([[[1], []], ['arbitrary data!!!'], [], [[], []]]);

// toInput
let input = type.toInput(value);
expect(input).toEqual({
  fields: [Field.zero],
  packed: [
    [Field.zero, 1],
    [Field.one, 32],
    [Field(2), 32],
  ],
});

// toJSON
expect(type.toJSON(value)).toEqual({
  nested: { a: 1, b: null },
  other: 'arbitrary data!!!',
  pk: PublicKey.toBase58(PublicKey.empty()),
  uint: ['1', '2'],
});

// fromFields
let restored = type.fromFields(fields, aux);
expect(JSON.stringify(restored)).toEqual(original);

// check
Circuit.runAndCheck(() => {
  type.check(value);
});

// should fail to create witness if `check` doesn't pass
expect(() =>
  Circuit.runAndCheck(() => {
    Circuit.witness(type, () => ({
      ...value,
      uint: [
        UInt32.zero,
        // invalid Uint32
        new UInt32(Field.minusOne),
      ],
    }));
  })
).toThrow(`Expected ${Field.minusOne} to fit in 32 bits`);

// class version of `circuitValue`
class MyCircuitValue extends circuitValueClass({
  nested: { a: Number, b: undefined },
  other: String,
  pk: PublicKey,
  uint: [UInt32, UInt32],
}) {}

let targetString = 'some particular string';
let gotTargetString = false;

// create a smart contract and pass auxiliary data to a method
class MyContract extends SmartContract {
  @method myMethod(value: MyCircuitValue) {
    if (value.other === targetString) gotTargetString = true;
    value.uint[0].assertEquals(UInt32.zero);
  }
}

setActiveInstance(LocalBlockchain());

MyContract.compile();
let address = PrivateKey.random().toPublicKey();
let contract = new MyContract(address);

let tx = await transaction(() => {
  contract.myMethod({
    nested: { a: 1, b: undefined },
    other: 'some particular string',
    pk: PublicKey.empty(),
    uint: [UInt32.from(0), UInt32.from(10)],
  });
});

gotTargetString = false;

await tx.prove();

// assert that prover got the target string
expect(gotTargetString).toEqual(true);

shutdown();
