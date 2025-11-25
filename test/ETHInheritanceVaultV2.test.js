const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("ETHInheritanceVaultV2", function () {
  async function deployVaultFixture() {
    const [testator, heir, commissionWallet, other] = await ethers.getSigners();

    const inactivityPeriod = 60 * 60 * 24 * 30; // 30 días

    const Vault = await ethers.getContractFactory("ETHInheritanceVaultV2");
    const vault = await Vault.deploy(
      testator.address,
      inactivityPeriod,
      commissionWallet.address
    );
    await vault.waitForDeployment();

    return { vault, testator, heir, commissionWallet, other, inactivityPeriod };
  }

  it("constructor: inicializa parámetros correctamente", async function () {
    const { vault, testator, commissionWallet, inactivityPeriod } =
      await deployVaultFixture();

    expect(await vault.testator()).to.equal(testator.address);
    expect(await vault.commissionWallet()).to.equal(commissionWallet.address);
    expect(await vault.inactivityPeriod()).to.equal(inactivityPeriod);

    const lastCheckIn = await vault.lastCheckIn();
    const createdAt = await vault.createdAt();
    expect(lastCheckIn).to.be.gt(0n);
    expect(createdAt).to.be.gt(0n);

    // Status inicial: Active (0)
    expect(await vault.inheritanceStatus()).to.equal(0);
  });

  it("constructor: revierte con direcciones inválidas o inactivity 0", async function () {
    const [, , commissionWallet] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("ETHInheritanceVaultV2");

    await expect(
      Vault.deploy(
        ethers.ZeroAddress,
        30 * 24 * 60 * 60,
        commissionWallet.address
      )
    ).to.be.revertedWith("Invalid testator");

    const [testator] = await ethers.getSigners();

    await expect(
      Vault.deploy(testator.address, 0, commissionWallet.address)
    ).to.be.revertedWith("Invalid inactivity period");

    await expect(
      Vault.deploy(testator.address, 30 * 24 * 60 * 60, ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid commission wallet");
  });

  it("registerInheritance: free tier (≤0.01 ETH) sin comisión", async function () {
    const { vault, testator, heir, inactivityPeriod } =
      await deployVaultFixture();

    const amount = ethers.parseEther("0.01"); // FREE_TIER_MAX_WEI

    await expect(
      vault
        .connect(testator)
        .registerInheritance(heir.address, { value: amount })
    )
      .to.emit(vault, "InheritanceRegistered")
      .withArgs(testator.address, heir.address, amount, inactivityPeriod)
      .and.to.emit(vault, "FeeApplied")
      .withArgs(testator.address, 0, 0, 0, amount);

    const vaultAddress = await vault.getAddress();
    const vaultBalance = await ethers.provider.getBalance(vaultAddress);
    expect(vaultBalance).to.equal(amount);

    const inheritanceAmount = await vault.inheritanceAmount();
    expect(inheritanceAmount).to.equal(amount);

    const storedHeir = await vault.heir();
    expect(storedHeir).to.equal(heir.address);
  });

  it("registerInheritance: revierte si el neto es menor al mínimo", async function () {
    const { vault, testator, heir } = await deployVaultFixture();

    const tooSmall = ethers.parseEther("0.000009");

    await expect(
      vault
        .connect(testator)
        .registerInheritance(heir.address, { value: tooSmall })
    ).to.be.revertedWith("Deposit too small, minimum is 0.00001000 ETH");
  });

  it("registerInheritance: aplica comisión dinámica para montos grandes (sin cap)", async function () {
    const { vault, testator, heir, inactivityPeriod, commissionWallet } =
      await deployVaultFixture();

    const amount = ethers.parseEther("1.0"); // 1 ETH
    const bps = 80n;
    const BPS_DENOM = 10_000n;
    const fee = (amount * bps) / BPS_DENOM; // 0.008 ETH
    const cap = ethers.parseEther("0.20");  // 0.20 ETH
    const expectedFee = fee;                // raw < cap → fee = raw
    const expectedNet = amount - expectedFee;

    const commissionBalanceBefore = await ethers.provider.getBalance(
      commissionWallet.address
    );

    const tx = await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: amount });

    await expect(tx)
      .to.emit(vault, "InheritanceRegistered")
      .withArgs(testator.address, heir.address, expectedNet, inactivityPeriod)
      .and.to.emit(vault, "FeeApplied")
      .withArgs(testator.address, bps, cap, expectedFee, amount);

    const commissionBalanceAfter = await ethers.provider.getBalance(
      commissionWallet.address
    );
    expect(commissionBalanceAfter - commissionBalanceBefore).to.equal(
      expectedFee
    );

    const vaultAddress = await vault.getAddress();
    const vaultBalance = await ethers.provider.getBalance(vaultAddress);
    expect(vaultBalance).to.equal(expectedNet);

    const inheritanceAmount = await vault.inheritanceAmount();
    expect(inheritanceAmount).to.equal(expectedNet);
  });

  it("registerInheritance: sólo el testador puede registrar", async function () {
    const { vault, heir, other } = await deployVaultFixture();

    await expect(
      vault
        .connect(other)
        .registerInheritance(heir.address, { value: ethers.parseEther("1") })
    ).to.be.revertedWith("Only the testator can register");
  });

  it("registerInheritance: no permite 2 registros", async function () {
    const { vault, testator, heir } = await deployVaultFixture();

    await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: ethers.parseEther("0.01") });

    await expect(
      vault
        .connect(testator)
        .registerInheritance(heir.address, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWith("Inheritance already registered");
  });

  it("performCheckIn: sólo testador, actualiza lastCheckIn", async function () {
    const { vault, testator, heir, other } = await deployVaultFixture();

    await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: ethers.parseEther("0.01") });

    const before = await vault.lastCheckIn();

    await expect(vault.connect(other).performCheckIn()).to.be.revertedWith(
      "Only the testator can confirm activity"
    );

    await expect(vault.connect(testator).performCheckIn())
      .to.emit(vault, "CheckInPerformed")
      .withArgs(testator.address, anyValue);

    const after = await vault.lastCheckIn();
    expect(after).to.be.gt(before);
  });

  it("cancelInheritance: sólo testador, reembolsa saldo y marca Cancelled", async function () {
    const { vault, testator, heir, other } = await deployVaultFixture();

    const deposit = ethers.parseEther("0.01");
    await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: deposit });

    await expect(vault.connect(other).cancelInheritance()).to.be.revertedWith(
      "Only testator can cancel"
    );

    const vaultAddress = await vault.getAddress();
    const balanceBefore = await ethers.provider.getBalance(vaultAddress);

    const tx = await vault.connect(testator).cancelInheritance();
    await expect(tx)
      .to.emit(vault, "InheritanceCancelled")
      .withArgs(testator.address, balanceBefore);

    const balanceAfter = await ethers.provider.getBalance(vaultAddress);
    expect(balanceAfter).to.equal(0n);

    const status = await vault.inheritanceStatus();
    expect(status).to.equal(2); // Cancelled
  });

  it("claimInheritance: sólo heredero, sólo después de inactivityPeriod, marca Released", async function () {
    const {
      vault,
      testator,
      heir,
      other,
      inactivityPeriod,
    } = await deployVaultFixture();

    const deposit = ethers.parseEther("0.5");

    // 1) Registrar herencia con depósito
    await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: deposit });

    // 2) Antes del inactivityPeriod: incluso el heredero no puede reclamar
    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Testator is still active");

    // 3) Avanzamos el tiempo más allá del inactivityPeriod
    await time.increase(inactivityPeriod + 1);

    // 4) Un address que NO es el heredero ahora falla por "Only the heir can claim"
    await expect(
      vault.connect(other).claimInheritance()
    ).to.be.revertedWith("Only the heir can claim");

    // 5) El heredero sí puede reclamar, el vault queda Released y sin balance
    const vaultAddress = await vault.getAddress();
    const balVaultBefore = await ethers.provider.getBalance(vaultAddress);
    expect(balVaultBefore).to.be.gt(0n);

    await vault.connect(heir).claimInheritance();

    const balVaultAfter = await ethers.provider.getBalance(vaultAddress);
    expect(balVaultAfter).to.equal(0n);

    const status = await vault.inheritanceStatus();
    // enum Status { Active, Released, Cancelled } → Released = 1
    expect(status).to.equal(1);
  });

  it("getInheritanceDetails: devuelve datos coherentes", async function () {
    const { vault, testator, heir } = await deployVaultFixture();

    const deposit = ethers.parseEther("0.01");
    await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: deposit });

    const details = await vault.getInheritanceDetails();
    const [h, amount, last, created, status] = details;

    expect(h).to.equal(heir.address);
    expect(amount).to.equal(deposit);
    expect(last).to.be.gt(0n);
    expect(created).to.be.gt(0n);
    expect(status).to.equal(0); // Active
  });

  it("receive/fallback: rechazan ETH directo", async function () {
    const { vault, testator } = await deployVaultFixture();
    const vaultAddress = await vault.getAddress();

    await expect(
      testator.sendTransaction({
        to: vaultAddress,
        value: ethers.parseEther("0.001"),
      })
    ).to.be.revertedWith("use registerInheritance");
  });

  // ============================
  // TESTS EXTRA PARA COVERAGE
  // ============================

  it("registerInheritance: aplica cap para depósitos muy grandes (2000 ETH)", async function () {
    const { vault, testator, heir, inactivityPeriod, commissionWallet } =
      await deployVaultFixture();

    const amount = ethers.parseEther("2000"); // > 1000 ETH → cap = 0.75
    const bps = 50n; // último tramo de _feeBps
    const BPS_DENOM = 10_000n;
    const rawFee = (amount * bps) / BPS_DENOM; // 2000 * 0.5% = 10 ETH
    const cap = ethers.parseEther("0.75");     // desde _capWei para > 1000 ETH
    const expectedFee = cap;                   // se aplica cap
    const expectedNet = amount - expectedFee;

    const commissionBalanceBefore = await ethers.provider.getBalance(
      commissionWallet.address
    );

    const tx = await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: amount });

    await expect(tx)
      .to.emit(vault, "InheritanceRegistered")
      .withArgs(testator.address, heir.address, expectedNet, inactivityPeriod)
      .and.to.emit(vault, "FeeApplied")
      .withArgs(testator.address, bps, cap, expectedFee, amount);

    const commissionBalanceAfter = await ethers.provider.getBalance(
      commissionWallet.address
    );
    expect(commissionBalanceAfter - commissionBalanceBefore).to.equal(
      expectedFee
    );

    const vaultAddress = await vault.getAddress();
    const vaultBalance = await ethers.provider.getBalance(vaultAddress);
    expect(vaultBalance).to.equal(expectedNet);

    const inheritanceAmount = await vault.inheritanceAmount();
    expect(inheritanceAmount).to.equal(expectedNet);
  });

  it("cancelInheritance: revierte cuando no hay balance en el vault", async function () {
    const { vault, testator } = await deployVaultFixture();

    await expect(
      vault.connect(testator).cancelInheritance()
    ).to.be.revertedWith("No balance to return");
  });

  it("performCheckIn: revierte si la herencia no está activa (Cancelada)", async function () {
    const { vault, testator, heir } = await deployVaultFixture();

    await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: ethers.parseEther("0.02") });

    await vault.connect(testator).cancelInheritance();

    await expect(
      vault.connect(testator).performCheckIn()
    ).to.be.revertedWith("Inheritance is not active");
  });

  it("claimInheritance: revierte si la herencia no está activa (Cancelada)", async function () {
    const { vault, testator, heir, inactivityPeriod } =
      await deployVaultFixture();

    await vault
      .connect(testator)
      .registerInheritance(heir.address, { value: ethers.parseEther("0.02") });

    await vault.connect(testator).cancelInheritance();

    await time.increase(inactivityPeriod + 1);

    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Inheritance is not active");
  });
});