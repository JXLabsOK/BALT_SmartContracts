// test/BALTPaymentsFactoryUSD6.test.js
const { expect } = require("chai");
const hre = require("hardhat");

const { ethers } = hre;

describe("BALTPaymentsFactoryUSD6 + BALTPaymentVaultUSD6", function () {
  let admin, payer, other, inactivePayer;
  let registry, factory;
  let tokenUSD6, tokenUSD18;

  const inactivityPeriod = 60 * 60 * 24 * 30; // 30 days
  const shortInactivity = 60 * 60 * 24; // 1 day
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

  async function createVault(
    signer = payer,
    period = inactivityPeriod,
    tokenAddress = tokenUSD6.target
  ) {
    const tx = await factory
      .connect(signer)
      .createPaymentVault(tokenAddress, period);

    const receipt = await tx.wait();

    const event = receipt.logs.find(
      (log) => log.fragment && log.fragment.name === "VaultCreated"
    );

    expect(event).to.exist;

    return event.args.vaultAddress;
  }

  beforeEach(async () => {
    [admin, payer, other, inactivePayer] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("BALTPaymentsSubscriptionRegistry");
    registry = await Registry.connect(admin).deploy();
    await registry.waitForDeployment();

    const TokenUSD6 = await ethers.getContractFactory("MockERC20USD6");
    tokenUSD6 = await TokenUSD6
      .connect(admin)
      .deploy(
        "Mock USDC",
        "mUSDC",
        ethers.parseUnits("1000000", 6)
      );
    await tokenUSD6.waitForDeployment();

    const TokenUSD18 = await ethers.getContractFactory("MockERC20");
    tokenUSD18 = await TokenUSD18.connect(admin).deploy();
    await tokenUSD18.waitForDeployment();

    const Factory = await ethers.getContractFactory("BALTPaymentsFactoryUSD6");
    factory = await Factory.connect(admin).deploy(registry.target);
    await factory.waitForDeployment();

    await activateSubscription(payer);
  });

  // ---------------- Deployment ----------------

  it("should deploy with a valid subscription registry", async function () {
    expect(await factory.subscriptionRegistry()).to.equal(registry.target);
  });

  it("should revert if deployed with zero subscription registry address", async function () {
    const Factory = await ethers.getContractFactory("BALTPaymentsFactoryUSD6");

    await expect(
      Factory.connect(admin).deploy(ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid subscription registry");
  });

  it("should revert if deployed with non-contract subscription registry", async function () {
    const Factory = await ethers.getContractFactory("BALTPaymentsFactoryUSD6");

    await expect(
      Factory.connect(admin).deploy(other.address)
    ).to.be.revertedWith("Registry must be contract");
  });

  // ---------------- Subscription validation ----------------

  it("should revert when payer subscription is inactive", async function () {
    await expect(
      factory
        .connect(inactivePayer)
        .createPaymentVault(tokenUSD6.target, inactivityPeriod)
    ).to.be.revertedWith("Subscription inactive");
  });

  it("should allow an active payer to create a USD6 payment vault", async function () {
    const tx = await factory
      .connect(payer)
      .createPaymentVault(tokenUSD6.target, inactivityPeriod);

    await expect(tx).to.emit(factory, "VaultCreated");
  });

  // ---------------- Vault creation ----------------

  it("should create a new USD6 payment vault and emit VaultCreated", async function () {
    const tx = await factory
      .connect(payer)
      .createPaymentVault(tokenUSD6.target, inactivityPeriod);

    await expect(tx).to.emit(factory, "VaultCreated");

    const receipt = await tx.wait();

    const event = receipt.logs.find(
      (log) => log.fragment && log.fragment.name === "VaultCreated"
    );

    expect(event).to.exist;
    expect(event.args.payer).to.equal(payer.address);
    expect(event.args.paymentToken).to.equal(tokenUSD6.target);
    expect(event.args.inactivityPeriod).to.equal(inactivityPeriod);

    const vaultAddress = event.args.vaultAddress;
    expect(ethers.isAddress(vaultAddress)).to.equal(true);
  });

  it("should return the address of the newly created vault using staticCall", async function () {
    const expected = await factory
      .connect(payer)
      .createPaymentVault
      .staticCall(tokenUSD6.target, inactivityPeriod);

    const tx = await factory
      .connect(payer)
      .createPaymentVault(tokenUSD6.target, inactivityPeriod);

    const receipt = await tx.wait();

    const event = receipt.logs.find(
      (log) => log.fragment && log.fragment.name === "VaultCreated"
    );

    const actual = event.args.vaultAddress;

    expect(actual).to.equal(expected);
  });

  it("should create unique USD6 payment vault addresses", async function () {
    const vault1 = await createVault(payer);
    const vault2 = await createVault(payer);

    expect(vault1).to.not.equal(vault2);
    expect(ethers.isAddress(vault1)).to.equal(true);
    expect(ethers.isAddress(vault2)).to.equal(true);
  });

  it("should initialize the created USD6 vault with expected values", async function () {
    const vaultAddress = await createVault(payer, shortInactivity);

    const Vault = await ethers.getContractFactory("BALTPaymentVaultUSD6");
    const vault = Vault.attach(vaultAddress);

    expect(await vault.payer()).to.equal(payer.address);
    expect(await vault.paymentToken()).to.equal(tokenUSD6.target);
    expect(await vault.subscriptionRegistry()).to.equal(registry.target);
    expect(await vault.inactivityPeriod()).to.equal(shortInactivity);
    expect(await vault.tokenDecimals()).to.equal(6);
    expect(await vault.paymentStatus()).to.equal(0); // Status.Idle
  });

  // ---------------- Input validation ----------------

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

  it("should revert if payment token does not have 6 decimals", async function () {
    await expect(
      factory
        .connect(payer)
        .createPaymentVault(tokenUSD18.target, inactivityPeriod)
    ).to.be.revertedWith("Token must have 6 decimals");
  });

  it("should revert if inactivity period is zero", async function () {
    await expect(
      factory
        .connect(payer)
        .createPaymentVault(tokenUSD6.target, 0)
    ).to.be.revertedWith("Invalid inactivity period");
  });

  // ---------------- Registry / getters ----------------

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

    all.forEach((addr) => {
      expect(ethers.isAddress(addr)).to.equal(true);
    });
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
      .staticCall(tokenUSD6.target, inactivityPeriod);

    await (
      await factory
        .connect(payer)
        .createPaymentVault(tokenUSD6.target, inactivityPeriod)
    ).wait();

    const v2 = await factory
      .connect(payer)
      .createPaymentVault
      .staticCall(tokenUSD6.target, inactivityPeriod);

    await (
      await factory
        .connect(payer)
        .createPaymentVault(tokenUSD6.target, inactivityPeriod)
    ).wait();

    const v3 = await factory
      .connect(payer)
      .createPaymentVault
      .staticCall(tokenUSD6.target, inactivityPeriod);

    await (
      await factory
        .connect(payer)
        .createPaymentVault(tokenUSD6.target, inactivityPeriod)
    ).wait();

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