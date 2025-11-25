const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("ERC20InheritanceVaultUSD6V2", function () {
  async function deployUSD6VaultFixture() {
    const [testator, heir, commissionWallet, other] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20USD6");
    const initialSupply = ethers.parseUnits("1000000000", 6); // 1,000,000,000 tokens

    // Deploy mock token desde el testator para que tenga el balance
    const token = await MockToken.connect(testator).deploy(
      "Mock USD6",
      "mUSD6",
      initialSupply
    );
    await token.waitForDeployment();

    const inactivityPeriod = 30 * 24 * 60 * 60; // 30 días
    const feeBps = 80; // 0.8% base
    const minDeposit = ethers.parseUnits("10", 6); // mínimo neto: 10 tokens

    const Vault = await ethers.getContractFactory("ERC20InheritanceVaultUSD6V2");
    const vault = await Vault.deploy(
      testator.address,
      inactivityPeriod,
      commissionWallet.address,
      await token.getAddress(),
      feeBps,
      minDeposit
    );
    await vault.waitForDeployment();

    const vaultAddress = await vault.getAddress();

    // Aprobamos el vault para poder hacer transferFrom en los tests
    await token.connect(testator).approve(vaultAddress, ethers.MaxUint256);

    return {
      vault,
      token,
      testator,
      heir,
      commissionWallet,
      other,
      inactivityPeriod,
      minDeposit,
      feeBps,
      vaultAddress,
    };
  }

  it("constructor: inicializa parámetros correctamente", async function () {
    const {
      vault,
      token,
      testator,
      commissionWallet,
      inactivityPeriod,
    } = await loadFixture(deployUSD6VaultFixture);

    expect(await vault.testator()).to.equal(testator.address);
    expect(await vault.commissionWallet()).to.equal(commissionWallet.address);
    expect(await vault.token()).to.equal(await token.getAddress());
    expect(await vault.inactivityPeriod()).to.equal(inactivityPeriod);

    // decimals del token (fijados a 6) quedaron cacheados en tokenDecimals
    expect(await vault.tokenDecimals()).to.equal(6);

    const lastCheckIn = await vault.lastCheckIn();
    const createdAt = await vault.createdAt();
    expect(lastCheckIn).to.be.gt(0n);
    expect(createdAt).to.be.gt(0n);

    // Status inicial: Active (0)
    expect(await vault.inheritanceStatus()).to.equal(0);
  });

  it("registerInheritance: free tier (≤ 1000 tokens) sin comisión", async function () {
    const {
      vault,
      token,
      testator,
      heir,
      inactivityPeriod,
      commissionWallet,
      vaultAddress,
    } = await loadFixture(deployUSD6VaultFixture);

    const amount = ethers.parseUnits("1000", 6); // FREE_TIER_MAX = 1000 tokens

    const commissionBalanceBefore = await token.balanceOf(commissionWallet.address);

    const tx = await vault
      .connect(testator)
      .registerInheritance(heir.address, amount);

    await expect(tx)
      .to.emit(vault, "InheritanceRegistered")
      .withArgs(testator.address, heir.address, amount, inactivityPeriod)
      .and.to.emit(vault, "FeeApplied")
      .withArgs(testator.address, 0, 0, 0, amount);

    const commissionBalanceAfter = await token.balanceOf(commissionWallet.address);
    expect(commissionBalanceAfter - commissionBalanceBefore).to.equal(0n);

    const vaultBalance = await token.balanceOf(vaultAddress);
    expect(vaultBalance).to.equal(amount);

    const inheritanceAmount = await vault.inheritanceAmount();
    expect(inheritanceAmount).to.equal(amount);

    const storedHeir = await vault.heir();
    expect(storedHeir).to.equal(heir.address);
  });

  it("registerInheritance: revierte si el neto es menor al minDeposit", async function () {
    const { vault, testator, heir, minDeposit } =
      await loadFixture(deployUSD6VaultFixture);

    // Depósito menor al minDeposit (asumimos minDeposit = 10 tokens)
    const tooSmall = ethers.parseUnits("5", 6);

    await expect(
      vault.connect(testator).registerInheritance(heir.address, tooSmall)
    ).to.be.revertedWith("Deposit too small");
  });

  it("registerInheritance: aplica comisión dinámica para montos grandes", async function () {
    const {
      vault,
      token,
      testator,
      heir,
      inactivityPeriod,
      commissionWallet,
      feeBps,
      vaultAddress,
    } = await loadFixture(deployUSD6VaultFixture);

    // Depósito de 1,000,000 tokens:
    //  - > 500,000 y ≤ 3,000,000 → feeBps - 10
    const amount = ethers.parseUnits("1000000", 6); // 1,000,000 tokens

    const BPS_DENOM = 10_000n;
    const bps = BigInt(feeBps) - 10n; // TIER2
    const expectedRawFee = (amount * bps) / BPS_DENOM; // sin llegar al cap
    const expectedCap = ethers.parseUnits("20000", 6); // CAP1_VALUE (20,000 tokens)
    const expectedFee = expectedRawFee; // raw < cap
    const expectedNet = amount - expectedFee;

    const commissionBalanceBefore = await token.balanceOf(commissionWallet.address);

    const tx = await vault
      .connect(testator)
      .registerInheritance(heir.address, amount);

    await expect(tx)
      .to.emit(vault, "InheritanceRegistered")
      .withArgs(testator.address, heir.address, expectedNet, inactivityPeriod)
      .and.to.emit(vault, "FeeApplied")
      .withArgs(testator.address, bps, expectedCap, expectedFee, amount);

    const commissionBalanceAfter = await token.balanceOf(commissionWallet.address);
    expect(commissionBalanceAfter - commissionBalanceBefore).to.equal(expectedFee);

    const vaultBalance = await token.balanceOf(vaultAddress);
    expect(vaultBalance).to.equal(expectedNet);

    const inheritanceAmount = await vault.inheritanceAmount();
    expect(inheritanceAmount).to.equal(expectedNet);
  });

  it("registerInheritance: sólo el testador puede registrar", async function () {
    const { vault, heir, other } = await loadFixture(deployUSD6VaultFixture);

    await expect(
      vault
        .connect(other)
        .registerInheritance(heir.address, ethers.parseUnits("1000", 6))
    ).to.be.revertedWith("Only the testator can register");
  });

  it("registerInheritance: no permite 2 registros", async function () {
    const { vault, testator, heir } = await loadFixture(deployUSD6VaultFixture);

    await vault
      .connect(testator)
      .registerInheritance(heir.address, ethers.parseUnits("1000", 6));

    await expect(
      vault
        .connect(testator)
        .registerInheritance(heir.address, ethers.parseUnits("1000", 6))
    ).to.be.revertedWith("Inheritance already registered");
  });

  it("performCheckIn: sólo testador, actualiza lastCheckIn", async function () {
    const { vault, testator, heir, other } =
      await loadFixture(deployUSD6VaultFixture);

    await vault
      .connect(testator)
      .registerInheritance(heir.address, ethers.parseUnits("1000", 6));

    const before = await vault.lastCheckIn();

    await expect(vault.connect(other).performCheckIn()).to.be.revertedWith(
      "Only the testator"
    );

    await expect(vault.connect(testator).performCheckIn())
      .to.emit(vault, "CheckInPerformed")
      .withArgs(testator.address, anyValue);

    const after = await vault.lastCheckIn();
    expect(after).to.be.gt(before);
  });

  it("cancelInheritance: sólo testador, reembolsa saldo y marca Cancelled", async function () {
    const { vault, token, testator, heir, other, vaultAddress } =
      await loadFixture(deployUSD6VaultFixture);

    const deposit = ethers.parseUnits("1000", 6);

    await vault
      .connect(testator)
      .registerInheritance(heir.address, deposit);

    await expect(vault.connect(other).cancelInheritance()).to.be.revertedWith(
      "Only testator"
    );

    const balanceBefore = await token.balanceOf(vaultAddress);

    const tx = await vault.connect(testator).cancelInheritance();
    await expect(tx)
      .to.emit(vault, "InheritanceCancelled")
      .withArgs(testator.address, balanceBefore);

    const balanceAfter = await token.balanceOf(vaultAddress);
    expect(balanceAfter).to.equal(0n);

    const status = await vault.inheritanceStatus();
    // enum Status { Active, Released, Cancelled } → Cancelled = 2
    expect(status).to.equal(2);
  });

  it("claimInheritance: sólo heredero, sólo después de inactivityPeriod, marca Released", async function () {
    const {
      vault,
      token,
      testator,
      heir,
      other,
      inactivityPeriod,
      vaultAddress,
    } = await loadFixture(deployUSD6VaultFixture);

    const deposit = ethers.parseUnits("5000", 6); // algo mayor que minDeposit

    await vault
      .connect(testator)
      .registerInheritance(heir.address, deposit);

    // 1) Antes de que pase el periodo: ni siquiera el heredero puede reclamar
    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Testator active");

    // 2) Avanzamos el tiempo más allá del inactivityPeriod
    await time.increase(inactivityPeriod + 1);

    // 3) Otro address distinto al heredero falla con "Only heir"
    await expect(
      vault.connect(other).claimInheritance()
    ).to.be.revertedWith("Only heir");

    // 4) El heredero puede reclamar correctamente
    const balVaultBefore = await token.balanceOf(vaultAddress);
    expect(balVaultBefore).to.be.gt(0n);

    const heirBalanceBefore = await token.balanceOf(heir.address);

    const tx = await vault.connect(heir).claimInheritance();
    await expect(tx)
      .to.emit(vault, "InheritanceReleased")
      .withArgs(heir.address, balVaultBefore);

    const balVaultAfter = await token.balanceOf(vaultAddress);
    const heirBalanceAfter = await token.balanceOf(heir.address);

    expect(balVaultAfter).to.equal(0n);
    expect(heirBalanceAfter - heirBalanceBefore).to.equal(balVaultBefore);

    const status = await vault.inheritanceStatus();
    // Released = 1
    expect(status).to.equal(1);
  });

  it("getInheritanceDetails: devuelve datos coherentes", async function () {
    const { vault, testator, heir } =
      await loadFixture(deployUSD6VaultFixture);

    const deposit = ethers.parseUnits("1000", 6);

    await vault
      .connect(testator)
      .registerInheritance(heir.address, deposit);

    const [h, amount, last, created, status] =
      await vault.getInheritanceDetails();

    expect(h).to.equal(heir.address);
    expect(amount).to.equal(deposit);
    expect(last).to.be.gt(0n);
    expect(created).to.be.gt(0n);
    expect(status).to.equal(0); // Active
  });
});