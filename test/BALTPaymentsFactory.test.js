// test/BALTPaymentsFactory.test.js
const { expect } = require("chai");
const hre = require("hardhat");

const { ethers } = hre;
const isAddress = ethers.isAddress;

describe("BALTPaymentsFactory + BALTPaymentVault", function () {
  let payer, other, inactivePayer, admin;
  let registry, factory;
  let paymentToken;

  const inactivityPeriod = 60 * 60 * 24 * 30; // 30 days
  const shortInactivity = 60; // 60 seconds for fast tests
  const subscriptionDuration = 60 * 60 * 24 * 30; // 30 days

  async function getFutureTimestamp(secondsFromNow) {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block.timestamp) + BigInt(secondsFromNow);
  }

  async function activateSubscription(account) {
    const expiration = await getFutureTimestamp(subscriptionDuration);

    await (
      await registry
        .connect(admin)
        .setSubscription(account.address, expiration)
    ).wait();
  }

  async function createVault(signer = payer, period = inactivityPeriod, token = paymentToken) {
    const tx = await factory
      .connect(signer)
      .createPaymentVault(token, period);

    const receipt = await tx.wait();
    const ev = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated");

    expect(ev).to.exist;

    return ev.args.vaultAddress;
  }

  beforeEach(async () => {
    [payer, other, inactivePayer, admin] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("BALTPaymentsSubscriptionRegistry");
    registry = await Registry.connect(admin).deploy();
    await registry.waitForDeployment();

    const Factory = await ethers.getContractFactory("BALTPaymentsFactory");
    factory = await Factory.connect(admin).deploy(registry.target);
    await factory.waitForDeployment();

    // For factory-level tests, we only need a valid contract address.
    // ERC-20 transfers are not executed in these tests.
    paymentToken = registry.target;

    await activateSubscription(payer);
  });

  // ---------------- Factory deployment tests ----------------

  it("should deploy with a valid subscription registry", async function () {
    expect(await factory.subscriptionRegistry()).to.equal(registry.target);
  });

  it("should revert if deployed with zero subscription registry address", async function () {
    const Factory = await ethers.getContractFactory("BALTPaymentsFactory");

    await expect(
      Factory.connect(admin).deploy(ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid subscription registry");
  });

  // ---------------- Subscription validation tests ----------------

  it("should revert when payer subscription is inactive", async function () {
    await expect(
      factory
        .connect(inactivePayer)
        .createPaymentVault(paymentToken, inactivityPeriod)
    ).to.be.revertedWith("Subscription inactive");
  });

  it("should allow a payer with active subscription to create a vault", async function () {
    const tx = await factory
      .connect(payer)
      .createPaymentVault(paymentToken, inactivityPeriod);

    await expect(tx).to.emit(factory, "VaultCreated");
  });

  // ---------------- Vault creation tests ----------------

  it("should create a new payment vault and emit VaultCreated", async function () {
    const tx = await factory
      .connect(payer)
      .createPaymentVault(paymentToken, inactivityPeriod);

    await expect(tx).to.emit(factory, "VaultCreated");

    const receipt = await tx.wait();
    const ev = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated");

    expect(ev).to.exist;
    expect(ev.args.payer).to.equal(payer.address);
    expect(ev.args.paymentToken).to.equal(paymentToken);
    expect(ev.args.inactivityPeriod).to.equal(inactivityPeriod);

    const vaultAddress = ev.args.vaultAddress;
    expect(isAddress(vaultAddress)).to.equal(true);
  });

  it("should return the address of the newly created vault using staticCall", async function () {
    const expected = await factory
      .connect(payer)
      .createPaymentVault
      .staticCall(paymentToken, inactivityPeriod);

    const tx = await factory
      .connect(payer)
      .createPaymentVault(paymentToken, inactivityPeriod);

    const receipt = await tx.wait();
    const actual = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    expect(actual).to.equal(expected);
  });

  it("should create unique payment vault addresses", async function () {
    const vault1 = await createVault(payer);
    const vault2 = await createVault(payer);

    expect(vault1).to.not.equal(vault2);
    expect(isAddress(vault1)).to.equal(true);
    expect(isAddress(vault2)).to.equal(true);
  });

  it("should initialize the created vault with the expected constructor values", async function () {
    const vaultAddress = await createVault(payer, shortInactivity);

    const Vault = await ethers.getContractFactory("BALTPaymentVault");
    const vault = Vault.attach(vaultAddress);

    expect(await vault.payer()).to.equal(payer.address);
    expect(await vault.paymentToken()).to.equal(paymentToken);
    expect(await vault.subscriptionRegistry()).to.equal(registry.target);
    expect(await vault.inactivityPeriod()).to.equal(shortInactivity);
    expect(await vault.paymentStatus()).to.equal(0); // Status.Idle
  });

  // ---------------- Input validation tests ----------------

  it("should revert if payment token is zero address", async function () {
    await expect(
      factory
        .connect(payer)
        .createPaymentVault(ethers.ZeroAddress, inactivityPeriod)
    ).to.be.revertedWith("Invalid payment token");
  });

  it("should revert if payment token is not a contract", async function () {
    await expect(
      factory
        .connect(payer)
        .createPaymentVault(other.address, inactivityPeriod)
    ).to.be.revertedWith("Payment token must be contract");
  });

  it("should revert if inactivity period is zero", async function () {
    await expect(
      factory
        .connect(payer)
        .createPaymentVault(paymentToken, 0)
    ).to.be.revertedWith("Invalid inactivity period");
  });

  // ---------------- Registry / getters tests ----------------

  it("should return vaults by payer", async function () {
    const vaultAddress = await createVault(payer);

    const vaults = await factory
      .connect(other)
      .getVaultsByPayer(payer.address);

    expect(vaults.length).to.equal(1);
    expect(vaults[0]).to.equal(vaultAddress);
  });

  it("should return all created vaults", async function () {
    await createVault(payer);
    await createVault(payer);

    const all = await factory.getAllVaults();

    expect(all.length).to.equal(2);
    all.forEach((addr) => expect(isAddress(addr)).to.equal(true));
  });

  it("should keep vaults separated by payer", async function () {
    await activateSubscription(other);

    const payerVault = await createVault(payer);
    const otherVault = await createVault(other);

    const payerVaults = await factory.getVaultsByPayer(payer.address);
    const otherVaults = await factory.getVaultsByPayer(other.address);

    expect(payerVaults.length).to.equal(1);
    expect(otherVaults.length).to.equal(1);

    expect(payerVaults[0]).to.equal(payerVault);
    expect(otherVaults[0]).to.equal(otherVault);
  });

  it("should expose paginated getters with counts and slices", async function () {
    const v1 = await factory
      .connect(payer)
      .createPaymentVault
      .staticCall(paymentToken, inactivityPeriod);
    await (await factory.connect(payer).createPaymentVault(paymentToken, inactivityPeriod)).wait();

    const v2 = await factory
      .connect(payer)
      .createPaymentVault
      .staticCall(paymentToken, inactivityPeriod);
    await (await factory.connect(payer).createPaymentVault(paymentToken, inactivityPeriod)).wait();

    const v3 = await factory
      .connect(payer)
      .createPaymentVault
      .staticCall(paymentToken, inactivityPeriod);
    await (await factory.connect(payer).createPaymentVault(paymentToken, inactivityPeriod)).wait();

    expect(await factory.allVaultsCount()).to.equal(3);
    expect(await factory.vaultsByPayerCount(payer.address)).to.equal(3);

    const slice1 = await factory.getAllVaultsSlice(0, 2);
    expect(slice1.length).to.equal(2);
    expect(slice1[0]).to.equal(v1);
    expect(slice1[1]).to.equal(v2);

    const slice2 = await factory.getAllVaultsSlice(2, 10);
    expect(slice2.length).to.equal(1);
    expect(slice2[0]).to.equal(v3);

    const empty = await factory.getAllVaultsSlice(100, 10);
    expect(empty.length).to.equal(0);

    const byPayerSlice = await factory.getVaultsByPayerSlice(payer.address, 0, 10);
    expect(byPayerSlice.length).to.equal(3);
    expect(byPayerSlice[0]).to.equal(v1);
    expect(byPayerSlice[1]).to.equal(v2);
    expect(byPayerSlice[2]).to.equal(v3);
  });

  it("should return an empty payer slice when offset is out of bounds", async function () {
    await createVault(payer);

    const empty = await factory.getVaultsByPayerSlice(payer.address, 10, 5);

    expect(empty.length).to.equal(0);
  });

  it("should support paginated getters with limit greater than remaining vaults", async function () {
    const v1 = await createVault(payer);
    const v2 = await createVault(payer);

    const slice = await factory.getVaultsByPayerSlice(payer.address, 0, 10);

    expect(slice.length).to.equal(2);
    expect(slice[0]).to.equal(v1);
    expect(slice[1]).to.equal(v2);
  });
});