import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

// ──────────────────────── EIP-712 type definitions ─────────────────────
// MUST match `RELEASE_TYPEHASH` in `Bridge.sol` byte-for-byte:
//   keccak256("Release(address token,address recipient,uint256 amount,bytes32 stellarTxHash,uint256 nonce)")
// EIP-712 canonical type-string rules: no spaces, fields in declaration
// order, `uint256` not `uint`, `bytes32` not `bytes`.
const EIP712_DOMAIN = { name: "StellarPay Bridge", version: "1" };
const EIP712_TYPES = {
  Release: [
    { name: "token", type: "address" },
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "stellarTxHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
  ],
};

/**
 * Helper: produce a 65-byte EIP-712 typed-data signature from `signer`
 * over the `Release` struct. The on-chain digest is computed by
 * OpenZeppelin's `EIP712Upgradeable._hashTypedDataV4` (see
 * `Bridge.release`); this helper produces the matching off-chain
 * signature via `signer.signTypedData`.
 */
async function signRelease(
  bridgeAddress: string,
  chainId: number,
  signer: any,
  token: string,
  recipient: string,
  amount: bigint,
  stellarTxHash: string,
  nonce: bigint,
) {
  const domain = { ...EIP712_DOMAIN, chainId, verifyingContract: bridgeAddress };
  const value = { token, recipient, amount, stellarTxHash, nonce };
  const sig = await signer.signTypedData(domain, EIP712_TYPES, value);
  return { sig };
}

describe("Bridge", () => {
  async function deploy(opts?: { threshold?: number; attesters?: any[] }) {
    const [owner, user, attester1, attester2, attester3, recipient] =
      await ethers.getSigners();
    const Token = await ethers.getContractFactory("WrappedToken");
    const token = await Token.deploy(
      "Test",
      "TST",
      ethers.parseEther("1000000"),
      owner.address,
    );
    const Bridge = await ethers.getContractFactory("Bridge");
    // OZ 5.x `_disableInitializers()` permanently disables `initialize()`
    // on the implementation, so the canonical pattern is to deploy via
    // an ERC-1967 proxy. `upgrades.deployProxy` deploys the impl + the
    // proxy + atomically calls `initialize(attesters, threshold)`.
    const attesters = opts?.attesters ?? [
      attester1.address,
      attester2.address,
      attester3.address,
    ];
    const threshold = opts?.threshold ?? 2;
    const bridge = await upgrades.deployProxy(
      Bridge,
      [attesters, threshold],
      {
        initializer: "initialize",
        // OZ 5.x's `ReentrancyGuard` has a constructor that writes the
        // `NOT_ENTERED` sentinel to its ERC-7201 namespaced storage slot.
        // That write happens on the *implementation* at deploy time (not
        // the proxy), so it's safe but the OZ upgrades plugin flags it
        // by default. Opt in explicitly.
        unsafeAllow: ["constructor"],
      },
    );
    await bridge.waitForDeployment();
    await bridge.setTokenConfig(
      await token.getAddress(),
      true,
      ethers.parseEther("0.01"),
      ethers.parseEther("10000"),
    );
    await token.transfer(user.address, ethers.parseEther("1000"));
    await token
      .connect(user)
      .approve(await bridge.getAddress(), ethers.parseEther("1000"));
    // Pre-fund the bridge so `release` has tokens to send.
    await token.transfer(await bridge.getAddress(), ethers.parseEther("100"));
    return {
      owner,
      user,
      attester1,
      attester2,
      attester3,
      recipient,
      token,
      bridge,
    };
  }

  // ──────────────────────── lock / burn ────────────────────────

  it("locks tokens and emits Locked", async () => {
    const { user, token, bridge } = await deploy();
    const stellarDest = ethers.hexlify(ethers.randomBytes(32));
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const amount = ethers.parseEther("100");

    // `solidityPackedKeccak256` already returns the keccak256 hash of
    // the packed args; do NOT wrap it in another `ethers.keccak256`
    // call (that would hash the hash). The on-chain `Bridge.lock`
    // computes `keccak256(abi.encodePacked(msg.sender, token, amount,
    // salt, block.chainid))` exactly once.
    const expectedNonce = ethers.solidityPackedKeccak256(
      ["address", "address", "uint256", "bytes32", "uint256"],
      [
        user.address,
        await token.getAddress(),
        amount,
        salt,
        (await ethers.provider.getNetwork()).chainId,
      ],
    );

    await expect(
      bridge.connect(user).lock(await token.getAddress(), amount, stellarDest, salt),
    )
      .to.emit(bridge, "Locked")
      .withArgs(
        user.address,
        await token.getAddress(),
        amount,
        stellarDest,
        salt,
        expectedNonce,
      );
  });

  it("rejects reused salt", async () => {
    const { user, token, bridge } = await deploy();
    const stellarDest = ethers.hexlify(ethers.randomBytes(32));
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const amount = ethers.parseEther("10");

    await bridge
      .connect(user)
      .lock(await token.getAddress(), amount, stellarDest, salt);
    await expect(
      bridge
        .connect(user)
        .lock(await token.getAddress(), amount, stellarDest, salt),
    ).to.be.revertedWithCustomError(bridge, "Bridge__SaltReused");
  });

  it("rejects amount below min", async () => {
    const { user, token, bridge } = await deploy();
    const stellarDest = ethers.hexlify(ethers.randomBytes(32));
    const salt = ethers.hexlify(ethers.randomBytes(32));
    await expect(
      bridge
        .connect(user)
        .lock(await token.getAddress(), 1n, stellarDest, salt),
    ).to.be.revertedWithCustomError(bridge, "Bridge__AmountOutOfRange");
  });

  it("rejects when paused", async () => {
    const { owner, user, token, bridge } = await deploy();
    await bridge.connect(owner).setPaused(true);
    const stellarDest = ethers.hexlify(ethers.randomBytes(32));
    const salt = ethers.hexlify(ethers.randomBytes(32));
    await expect(
      bridge
        .connect(user)
        .lock(
          await token.getAddress(),
          ethers.parseEther("10"),
          stellarDest,
          salt,
        ),
    ).to.be.reverted; // OZ Pausable reverts without a custom error
  });

  it("rejects burn when paused (B-6)", async () => {
    const { owner, user, token, bridge } = await deploy();
    await bridge.connect(owner).setPaused(true);
    const stellarDest = ethers.hexlify(ethers.randomBytes(32));
    const salt = ethers.hexlify(ethers.randomBytes(32));
    // The pause modifier fires before the burnFrom interaction, so the
    // token not implementing burnFrom is irrelevant — any burn call
    // reverts while paused.
    await expect(
      bridge
        .connect(user)
        .burn(await token.getAddress(), ethers.parseEther("10"), stellarDest, salt),
    ).to.be.reverted; // OZ Pausable reverts without a custom error
  });

  it("rejects release when paused even with a valid quorum (B-6)", async () => {
    const { owner, attester1, attester2, recipient, token, bridge } = await deploy();
    const amount = ethers.parseEther("1");
    const stellarTxHash = ethers.hexlify(ethers.randomBytes(32));
    const nonce = 1n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const { sig: sig1 } = await signRelease(
      await bridge.getAddress(),
      Number(chainId),
      attester1,
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );
    const { sig: sig2 } = await signRelease(
      await bridge.getAddress(),
      Number(chainId),
      attester2,
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );

    await bridge.connect(owner).setPaused(true);
    // A valid 2-of-3 quorum still cannot release while paused.
    await expect(
      bridge
        .connect(recipient)
        .release(
          await token.getAddress(),
          recipient.address,
          amount,
          stellarTxHash,
          nonce,
          [sig1, sig2],
        ),
    ).to.be.reverted; // OZ Pausable reverts without a custom error
  });

  it("rejects zero destination (B-2: invalid dest)", async () => {
    const { user, token, bridge } = await deploy();
    const salt = ethers.hexlify(ethers.randomBytes(32));
    await expect(
      bridge
        .connect(user)
        .lock(
          await token.getAddress(),
          ethers.parseEther("10"),
          ethers.ZeroHash,
          salt,
        ),
    ).to.be.revertedWithCustomError(bridge, "Bridge__InvalidDest");
  });

  // ──────────────────────── release (EIP-712 multisig) ────────────────────────

  it("release requires threshold valid signatures", async () => {
    const { attester1, attester2, recipient, token, bridge } = await deploy();
    const amount = ethers.parseEther("1");
    const stellarTxHash = ethers.hexlify(ethers.randomBytes(32));
    const nonce = 1n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const { sig: sig1 } = await signRelease(
      await bridge.getAddress(),
      Number(chainId),
      attester1,
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );
    await expect(
      bridge
        .connect(recipient)
        .release(
          await token.getAddress(),
          recipient.address,
          amount,
          stellarTxHash,
          nonce,
          [sig1],
        ),
    ).to.be.revertedWithCustomError(bridge, "Bridge__InsufficientSignatures");
  });

  it("release succeeds with quorum of distinct attesters (EIP-712)", async () => {
    const { attester1, attester2, recipient, token, bridge } = await deploy();
    const amount = ethers.parseEther("1");
    const stellarTxHash = ethers.hexlify(ethers.randomBytes(32));
    const nonce = 1n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const { sig: sig1 } = await signRelease(
      await bridge.getAddress(),
      Number(chainId),
      attester1,
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );
    const { sig: sig2 } = await signRelease(
      await bridge.getAddress(),
      Number(chainId),
      attester2,
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );

    await expect(
      bridge
        .connect(recipient)
        .release(
          await token.getAddress(),
          recipient.address,
          amount,
          stellarTxHash,
          nonce,
          [sig1, sig2],
        ),
    )
      .to.emit(bridge, "Released")
      .withArgs(
        recipient.address,
        await token.getAddress(),
        amount,
        stellarTxHash,
        nonce,
      );
  });

  it("release rejects duplicate signatures from the same attester", async () => {
    const { attester1, recipient, token, bridge } = await deploy();
    const amount = ethers.parseEther("1");
    const stellarTxHash = ethers.hexlify(ethers.randomBytes(32));
    const nonce = 1n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const { sig: sig1 } = await signRelease(
      await bridge.getAddress(),
      Number(chainId),
      attester1,
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );

    await expect(
      bridge
        .connect(recipient)
        .release(
          await token.getAddress(),
          recipient.address,
          amount,
          stellarTxHash,
          nonce,
          [sig1, sig1],
        ),
    ).to.be.revertedWithCustomError(bridge, "Bridge__DuplicateSignature");
  });

  it("release rejects signatures from non-attesters", async () => {
    const { user, recipient, token, bridge } = await deploy();
    const amount = ethers.parseEther("1");
    const stellarTxHash = ethers.hexlify(ethers.randomBytes(32));
    const nonce = 1n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const { sig: bogus } = await signRelease(
      await bridge.getAddress(),
      Number(chainId),
      user, // `user` is NOT an attester
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );

    await expect(
      bridge
        .connect(recipient)
        .release(
          await token.getAddress(),
          recipient.address,
          amount,
          stellarTxHash,
          nonce,
          [bogus],
        ),
    ).to.be.revertedWithCustomError(bridge, "Bridge__NotAttester");
  });

  it("release rejects signatures signed for a different domain (B-7)", async () => {
    // Replay protection: a signature produced for one (chainId,
    // verifyingContract) pair must not verify on another. We forge a
    // signature against a fake bridge address and confirm the on-chain
    // EIP-712 check rejects it.
    const { attester1, attester2, recipient, token, bridge } = await deploy();
    const amount = ethers.parseEther("1");
    const stellarTxHash = ethers.hexlify(ethers.randomBytes(32));
    const nonce = 1n;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const FAKE_BRIDGE = "0x000000000000000000000000000000000000bEEF";
    const { sig: sig1 } = await signRelease(
      FAKE_BRIDGE,
      Number(chainId),
      attester1,
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );
    const { sig: sig2 } = await signRelease(
      FAKE_BRIDGE,
      Number(chainId),
      attester2,
      await token.getAddress(),
      recipient.address,
      amount,
      stellarTxHash,
      nonce,
    );

    // Both sigs are valid EIP-712 sigs over (FAKE_BRIDGE, chainId, ...),
    // but neither attester is recovered when the on-chain domain uses
    // the real bridge address — so the call reverts with NotAttester.
    await expect(
      bridge
        .connect(recipient)
        .release(
          await token.getAddress(),
          recipient.address,
          amount,
          stellarTxHash,
          nonce,
          [sig1, sig2],
        ),
    ).to.be.revertedWithCustomError(bridge, "Bridge__NotAttester");
  });

  // ──────────────────────── attester / pause admin ────────────────────────

  it("setAttesters rejects threshold == length (B-5)", async () => {
    const { owner, attester1, attester2, bridge } = await deploy();
    await expect(
      bridge
        .connect(owner)
        .setAttesters([attester1.address, attester2.address], 2),
    ).to.be.revertedWithCustomError(bridge, "Bridge__BadThreshold");
  });

  it("setAttesters rejects zero attester address", async () => {
    const { owner, attester1, bridge } = await deploy();
    await expect(
      bridge
        .connect(owner)
        .setAttesters(
          [attester1.address, ethers.ZeroAddress],
          1,
        ),
    ).to.be.revertedWithCustomError(bridge, "Bridge__ZeroAttester");
  });

  it("setAttesters rejects threshold == 0", async () => {
    const { owner, attester1, attester2, bridge } = await deploy();
    await expect(
      bridge
        .connect(owner)
        .setAttesters([attester1.address, attester2.address], 0),
    ).to.be.revertedWithCustomError(bridge, "Bridge__BadThreshold");
  });

  it("only owner can setAttesters", async () => {
    const { user, attester1, attester2, bridge } = await deploy();
    await expect(
      bridge
        .connect(user)
        .setAttesters([attester1.address, attester2.address], 1),
    ).to.be.reverted; // OZ Ownable revert
  });
});

describe("WrappedToken", () => {
  it("owner can mint, non-owner cannot", async () => {
    const [owner, user, recipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("WrappedToken");
    const token = await Token.deploy(
      "Test",
      "TST",
      ethers.parseEther("100"),
      owner.address,
    );
    await token.connect(owner).mint(recipient.address, ethers.parseEther("50"));
    expect(await token.balanceOf(recipient.address)).to.equal(
      ethers.parseEther("50"),
    );
    await expect(
      token.connect(user).mint(recipient.address, ethers.parseEther("1")),
    ).to.be.reverted; // OZ Ownable revert
  });
});
