// Vectors from hyperliquid-python-sdk tests/signing_test.py. The SDK prints r/s with
// to_hex(int) (no leading zeros); we emit 32-byte padded hex, so compare as integers.
import { describe, expect, test } from "bun:test";
import { encode } from "@msgpack/msgpack";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS } from "../src/config.ts";
import {
  actionHash,
  approveAgentAction,
  approveAgentTypedData,
  approveBuilderFeeAction,
  approveBuilderFeeTypedData,
  cancelAction,
  cancelByCloidAction,
  floatToIntForHashing,
  floatToWire,
  orderToWire,
  orderWireToAction,
  scheduleCancelAction,
  signApproveAgent,
  signApproveBuilderFee,
  signL1Action,
  signUserSignedAction,
  updateLeverageAction,
  type OrderRequest,
  type Signature,
} from "../src/signing.ts";

const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const MAIN = NETWORKS.mainnet;
const TEST = NETWORKS.testnet;

function expectSig(sig: Signature, r: string, s: string, v: number) {
  expect(BigInt(sig.r)).toBe(BigInt(r));
  expect(BigInt(sig.s)).toBe(BigInt(s));
  expect(sig.v).toBe(v);
  expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
  expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/);
}

const order100 = (extra: Partial<OrderRequest> = {}): OrderRequest => ({
  asset: 1,
  isBuy: true,
  sz: 100,
  limitPx: 100,
  reduceOnly: false,
  orderType: { limit: { tif: "Gtc" } },
  ...extra,
});

describe("SDK signing vectors", () => {
  test("test_phantom_agent_creation_matches_production", () => {
    const action = orderWireToAction([
      orderToWire({
        asset: 4,
        isBuy: true,
        sz: 0.0147,
        limitPx: 1670.1,
        reduceOnly: false,
        orderType: { limit: { tif: "Ioc" } },
      }),
    ]);
    expect(actionHash(action, null, 1677777606040, null)).toBe(
      "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908",
    );
  });

  test("test_l1_action_signing_matches", async () => {
    const action = { type: "dummy", num: floatToIntForHashing(1000) };
    expectSig(
      await signL1Action(wallet, action, 0, MAIN),
      "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
      "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
      27,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST),
      "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
      "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613",
      28,
    );
  });

  test("test_l1_action_signing_order_matches", async () => {
    const action = orderWireToAction([orderToWire(order100())]);
    expectSig(
      await signL1Action(wallet, action, 0, MAIN),
      "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
      28,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST),
      "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
      "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5",
      27,
    );
  });

  test("test_l1_action_signing_order_with_cloid_matches", async () => {
    const action = orderWireToAction([orderToWire(order100({ cloid: "0x00000000000000000000000000000001" }))]);
    expectSig(
      await signL1Action(wallet, action, 0, MAIN),
      "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
      "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da",
      27,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST),
      "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d",
      "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988",
      28,
    );
  });

  test("test_l1_action_signing_matches_with_vault", async () => {
    const action = { type: "dummy", num: floatToIntForHashing(1000) };
    const vault = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
    expectSig(
      await signL1Action(wallet, action, 0, MAIN, vault),
      "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239",
      "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c",
      28,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST, vault),
      "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b",
      "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60",
      27,
    );
  });

  test("test_l1_action_signing_tpsl_order_matches", async () => {
    const action = orderWireToAction([
      orderToWire(order100({ orderType: { trigger: { triggerPx: 103, isMarket: true, tpsl: "sl" } } })),
    ]);
    expectSig(
      await signL1Action(wallet, action, 0, MAIN),
      "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9",
      "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405",
      27,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST),
      "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4",
      "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac",
      28,
    );
  });

  test("test_float_to_int_for_hashing", () => {
    expect(floatToIntForHashing(123123123123)).toBe(12312312312300000000n);
    expect(floatToIntForHashing(0.00001231)).toBe(1231n);
    expect(floatToIntForHashing(1.033)).toBe(103300000n);
    expect(() => floatToIntForHashing(0.000012312312)).toThrow();
  });

  // sign_usd_transfer_action / sign_withdraw_from_bridge_action go through the same
  // user-signed path as approveAgent/approveBuilderFee, so they pin that path.
  const transfer = {
    signatureChainId: "0x66eee" as Hex,
    hyperliquidChain: "Testnet" as const,
    destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
    amount: "1",
    time: 1687816341423,
  };
  const transferTypes = [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ];

  test("test_sign_usd_transfer_action", async () => {
    expectSig(
      await signUserSignedAction(wallet, "HyperliquidTransaction:UsdSend", transferTypes, transfer),
      "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",
      "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7",
      27,
    );
  });

  test("test_sign_withdraw_from_bridge_action", async () => {
    expectSig(
      await signUserSignedAction(wallet, "HyperliquidTransaction:Withdraw", transferTypes, transfer),
      "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
      "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881",
      28,
    );
  });

  test("test_create_sub_account_action", async () => {
    const action = { type: "createSubAccount", name: "example" };
    expectSig(
      await signL1Action(wallet, action, 0, MAIN),
      "0x51096fe3239421d16b671e192f574ae24ae14329099b6db28e479b86cdd6caa7",
      "0xb71f7d293af92d3772572afb8b102d167a7cef7473388286bc01f52a5c5b423",
      27,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST),
      "0xa699e3ed5c2b89628c746d3298b5dc1cca604694c2c855da8bb8250ec8014a5b",
      "0x53f1b8153a301c72ecc655b1c315d64e1dcea3ee58921fd7507e35818fcc1584",
      28,
    );
  });

  test("test_sub_account_transfer_action", async () => {
    const action = {
      type: "subAccountTransfer",
      subAccountUser: "0x1d9470d4b963f552e6f671a81619d395877bf409",
      isDeposit: true,
      usd: 10,
    };
    expectSig(
      await signL1Action(wallet, action, 0, MAIN),
      "0x43592d7c6c7d816ece2e206f174be61249d651944932b13343f4d13f306ae602",
      "0x71a926cb5c9a7c01c3359ec4c4c34c16ff8107d610994d4de0e6430e5cc0f4c9",
      28,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST),
      "0xe26574013395ad55ee2f4e0575310f003c5bb3351b5425482e2969fa51543927",
      "0xefb08999196366871f919fd0e138b3a7f30ee33e678df7cfaf203e25f0a4278",
      28,
    );
  });

  test("test_schedule_cancel_action", async () => {
    let action = scheduleCancelAction();
    expectSig(
      await signL1Action(wallet, action, 0, MAIN),
      "0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9",
      "0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0",
      27,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST),
      "0xc75bb195c3f6a4e06b7d395acc20bbb224f6d23ccff7c6a26d327304e6efaeed",
      "0x342f8ede109a29f2c0723bd5efb9e9100e3bbb493f8fb5164ee3d385908233df",
      28,
    );
    action = scheduleCancelAction(123456789);
    expectSig(
      await signL1Action(wallet, action, 0, MAIN),
      "0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55",
      "0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b",
      28,
    );
    expectSig(
      await signL1Action(wallet, action, 0, TEST),
      "0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc",
      "0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678",
      27,
    );
  });
});

describe("wire format", () => {
  test("floatToWire matches Python normalisation", () => {
    expect(floatToWire(100)).toBe("100");
    expect(floatToWire(1670.1)).toBe("1670.1");
    expect(floatToWire(0.0147)).toBe("0.0147");
    expect(floatToWire(0)).toBe("0");
    expect(floatToWire(-0)).toBe("0");
    expect(floatToWire(0.00000001)).toBe("0.00000001");
    expect(floatToWire(123456789.12345678)).toBe("123456789.12345678");
    expect(() => floatToWire(0.000000001)).toThrow();
    expect(() => floatToWire(Number.NaN)).toThrow();
  });

  test("order wire key order and cloid", () => {
    const w = orderToWire(order100({ cloid: "0x00000000000000000000000000000001" }));
    expect(Object.keys(w)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
    expect(() => orderToWire(order100({ cloid: "0x01" }))).toThrow();
    const trig = orderToWire(order100({ orderType: { trigger: { triggerPx: 103, isMarket: true, tpsl: "sl" } } }));
    expect(Object.keys((trig.t as { trigger: object }).trigger)).toEqual(["isMarket", "triggerPx", "tpsl"]);
  });

  test("builder is lowercased and keyed b,f", () => {
    const a = orderWireToAction([], { b: "0xABCDEF0000000000000000000000000000000001", f: 10 });
    expect(a.builder).toEqual({ b: "0xabcdef0000000000000000000000000000000001", f: 10 });
    expect(Object.keys(a)).toEqual(["type", "orders", "grouping", "builder"]);
  });

  test("cancel / leverage action shapes", () => {
    expect(cancelAction([{ asset: 3, oid: 7 }])).toEqual({ type: "cancel", cancels: [{ a: 3, o: 7 }] });
    expect(cancelByCloidAction([{ asset: 3, cloid: "0x00000000000000000000000000000001" }])).toEqual({
      type: "cancelByCloid",
      cancels: [{ asset: 3, cloid: "0x00000000000000000000000000000001" }],
    });
    expect(Object.keys(updateLeverageAction(1, 5))).toEqual(["type", "asset", "isCross", "leverage"]);
  });

  test("msgpack int widths match Python (uint64 above 32 bits, smallest otherwise)", () => {
    // 1e11 as a plain number must hash identically to the bigint form.
    const a = actionHash({ type: "dummy", num: 100000000000 }, null, 0);
    const b = actionHash({ type: "dummy", num: 100000000000n }, null, 0);
    expect(a).toBe(b);
    expect(actionHash({ n: 5n }, null, 0)).toBe(actionHash({ n: 5 }, null, 0));
    expect(encode(5)).toEqual(new Uint8Array([5]));
  });

  test("expiresAfter changes the hash", () => {
    expect(actionHash({ type: "x" }, null, 1, 2)).not.toBe(actionHash({ type: "x" }, null, 1));
  });
});

describe("user-signed actions", () => {
  test("approveAgent typed data recovers to the signer, testnet chain", async () => {
    const action = approveAgentAction(
      { agentAddress: "0x0000000000000000000000000000000000000abc", agentName: "bot", nonce: 1700000000000 },
      TEST,
    );
    expect(action.hyperliquidChain).toBe("Testnet");
    expect(action.signatureChainId).toBe("0x66eee");
    const td = approveAgentTypedData(action);
    expect(td.domain).toEqual({
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 0x66eee,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    });
    expect(td.types["HyperliquidTransaction:ApproveAgent"]?.map((f) => f.name)).toEqual([
      "hyperliquidChain",
      "agentAddress",
      "agentName",
      "nonce",
    ]);
    const sig = await signApproveAgent(wallet, action);
    const recovered = await recoverTypedDataAddress({
      ...(td as Parameters<typeof recoverTypedDataAddress>[0]),
      signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) },
    });
    expect(recovered).toBe(wallet.address);
  });

  test("approveBuilderFee: mainnet uses 0xa4b1, validates rate", async () => {
    const action = approveBuilderFeeAction(
      { builder: "0x0000000000000000000000000000000000000abc", maxFeeRate: "0.05%", nonce: 1 },
      MAIN,
    );
    const td = approveBuilderFeeTypedData(action);
    expect(td.domain.chainId).toBe(0xa4b1);
    expect(td.message).toEqual({
      hyperliquidChain: "Mainnet",
      maxFeeRate: "0.05%",
      builder: "0x0000000000000000000000000000000000000abc",
      nonce: 1,
    });
    const sig = await signApproveBuilderFee(wallet, action);
    const recovered = await recoverTypedDataAddress({
      ...(td as Parameters<typeof recoverTypedDataAddress>[0]),
      signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) },
    });
    expect(recovered).toBe(wallet.address);
    expect(() => approveBuilderFeeAction({ builder: "0x00", maxFeeRate: "5", nonce: 1 }, MAIN)).toThrow();
  });
});
