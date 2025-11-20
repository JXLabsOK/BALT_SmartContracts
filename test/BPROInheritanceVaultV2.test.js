const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("BPROInheritanceVaultV2", function () {
  let deployer;
  let commissionWallet;
  let testator;
  let heir;
  let other;

  let token;
  let factory;
  let vault;
  let vaultAddress;

  let feeBps;
  let minDeposit;
  let inactivityPeriod;

  beforeEach(async function () {
    [deployer, commissionWallet, testator, heir, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy();
    await token.waitForDeployment();

    feeBps = 80; // 0.80% base
    minDeposit = ethers.parseUnits("0.00001", 18); // 0.00001000 BPRO neto mínimo

    // mint BPRO al testator
    await token.mint(testator.address, ethers.parseUnits("1000", 18));

    const Factory = await ethers.getContractFactory("BPROInheritanceFactoryV2");
    factory = await Factory.deploy(
      commissionWallet.address,
      await token.getAddress(),
      feeBps,
      minDeposit
    );
    await factory.waitForDeployment();

    inactivityPeriod = 30 * 24 * 60 * 60; // 30 días
    await factory.connect(testator).createInheritanceVault(inactivityPeriod);

    const vaults = await factory.getVaultsByTestator(testator.address);
    vaultAddress = vaults[0];

    vault = await ethers.getContractAt("BPROInheritanceVaultV2", vaultAddress);
  });

  it("free tier: depósito <= 0.01 BPRO no cobra comisión", async function () {
    const deposit = ethers.parseUnits("0.005", 18); // 0.005 BPRO < 0.01

    await token.connect(testator).approve(vaultAddress, deposit);

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    const net = await vault.inheritanceAmount();
    expect(net).to.equal(deposit);

    const commissionBal = await token.balanceOf(commissionWallet.address);
    expect(commissionBal).to.equal(0n);

    const vaultBal = await token.balanceOf(vaultAddress);
    expect(vaultBal).to.equal(deposit);

    const details = await vault.getInheritanceDetails();
    expect(details[0]).to.equal(heir.address); // heir
    expect(details[1]).to.equal(deposit);      // inheritanceAmount
  });

  it("primer tramo: cobra 0.8% sobre 1 BPRO sin cap", async function () {
    const deposit = ethers.parseUnits("1", 18); // 1 BPRO, dentro de TIER1 (<=5)
    await token.connect(testator).approve(vaultAddress, deposit);

    const expectedFee = (deposit * BigInt(feeBps)) / 10000n; // 1 * 80/10000 = 0.008
    const expectedNet = deposit - expectedFee;               // 0.992

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    const net = await vault.inheritanceAmount();
    expect(net).to.equal(expectedNet);

    const commissionBal = await token.balanceOf(commissionWallet.address);
    expect(commissionBal).to.equal(expectedFee);

    const vaultBal = await token.balanceOf(vaultAddress);
    expect(vaultBal).to.equal(expectedNet);
  });

  it("usa fee reducido (70 bps) en el tramo >5 y <=30 BPRO", async function () {
    const deposit = ethers.parseUnits("10", 18); // >5 y <=30 → feeBps - 10 = 70 bps
    await token.connect(testator).approve(vaultAddress, deposit);

    const effectiveBps = feeBps - 10; // 70
    const expectedFee = (deposit * BigInt(effectiveBps)) / 10000n;
    const expectedNet = deposit - expectedFee;

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    expect(await vault.inheritanceAmount()).to.equal(expectedNet);
    expect(await token.balanceOf(commissionWallet.address)).to.equal(expectedFee);
  });

  it("aplica correctamente el cap de 0.20 BPRO para depósitos de 50 BPRO", async function () {
    const deposit = ethers.parseUnits("50", 18); // 50 BPRO
    await token.connect(testator).approve(vaultAddress, deposit);

    // Tercera banda de fee: >30 y <=100 → feeBps - 20 = 60 bps
    const rawFee = (deposit * 60n) / 10000n; // 50 * 0.60% = 0.30
    const cap = ethers.parseUnits("0.2", 18); // CAP1_VALUE
    expect(rawFee).to.be.gt(cap); // nos aseguramos que realmente entra el cap

    const expectedFee = cap;
    const expectedNet = deposit - expectedFee;

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    expect(await vault.inheritanceAmount()).to.equal(expectedNet);
    expect(await token.balanceOf(commissionWallet.address)).to.equal(expectedFee);
    expect(await token.balanceOf(vaultAddress)).to.equal(expectedNet);
  });

  it("no permite registrar por alguien que no es el testador", async function () {
    const deposit = ethers.parseUnits("1", 18);
    await token.mint(other.address, deposit);
    await token.connect(other).approve(vaultAddress, deposit);

    await expect(
      vault.connect(other).registerInheritance(heir.address, deposit)
    ).to.be.revertedWith("Only the testator can register");
  });

  it("no permite registrar herencia dos veces", async function () {
    const deposit = ethers.parseUnits("1", 18);
    await token.connect(testator).approve(vaultAddress, deposit);

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    await expect(
      vault.connect(testator).registerInheritance(heir.address, deposit)
    ).to.be.revertedWith("Inheritance already registered");
  });

  it("revierta si el depósito neto es menor a minDeposit", async function () {
    // minDeposit = 0.00001
    const small = ethers.parseUnits("0.000001", 18); // menor a minDeposit
    await token.connect(testator).approve(vaultAddress, small);

    await expect(
      vault.connect(testator).registerInheritance(heir.address, small)
    ).to.be.revertedWith("Deposit too small");
  });

  it("performCheckIn sólo puede ser ejecutado por el testador y actualiza lastCheckIn", async function () {
    const deposit = ethers.parseUnits("1", 18);
    await token.connect(testator).approve(vaultAddress, deposit);
    await vault.connect(testator).registerInheritance(heir.address, deposit);

    const prevLastCheckIn = await vault.lastCheckIn();

    await expect(
      vault.connect(other).performCheckIn()
    ).to.be.revertedWith("Only the testator");

    await vault.connect(testator).performCheckIn();
    const newLastCheckIn = await vault.lastCheckIn();

    expect(newLastCheckIn).to.be.gt(prevLastCheckIn);
  });

  it("cancelInheritance devuelve el saldo del vault al testador y marca Cancelled", async function () {
    const deposit = ethers.parseUnits("10", 18);
    await token.connect(testator).approve(vaultAddress, deposit);

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    const vaultBalBefore = await token.balanceOf(vaultAddress);
    const testatorBalBefore = await token.balanceOf(testator.address);

    await vault.connect(testator).cancelInheritance();

    const vaultBalAfter = await token.balanceOf(vaultAddress);
    const testatorBalAfter = await token.balanceOf(testator.address);

    expect(await vault.inheritanceStatus()).to.equal(2); // Cancelled
    expect(vaultBalAfter).to.equal(0n);
    expect(testatorBalAfter).to.equal(testatorBalBefore + vaultBalBefore);
  });

  it("no permite cancelar si no es el testador", async function () {
    const deposit = ethers.parseUnits("1", 18);
    await token.connect(testator).approve(vaultAddress, deposit);
    await vault.connect(testator).registerInheritance(heir.address, deposit);

    await expect(
      vault.connect(other).cancelInheritance()
    ).to.be.revertedWith("Only testator");
  });

  it("no permite claim antes de cumplir el inactivityPeriod", async function () {
    const deposit = ethers.parseUnits("1", 18);
    await token.connect(testator).approve(vaultAddress, deposit);
    await vault.connect(testator).registerInheritance(heir.address, deposit);

    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Testator active");
  });

  it("permite claim luego de inactivityPeriod y sólo al heredero", async function () {
    const deposit = ethers.parseUnits("1", 18);
    await token.connect(testator).approve(vaultAddress, deposit);
    await vault.connect(testator).registerInheritance(heir.address, deposit);

    const net = await vault.inheritanceAmount();

    // Adelantamos tiempo para que ya no dispare "Testator active"
    await time.increase(inactivityPeriod + 1);

    // Otro address NO puede reclamar: ahora sí esperamos "Only heir"
    await expect(
      vault.connect(other).claimInheritance()
    ).to.be.revertedWith("Only heir");

    // El heredero SÍ puede reclamar
    const heirBalBefore = await token.balanceOf(heir.address);
    await vault.connect(heir).claimInheritance();
    const heirBalAfter = await token.balanceOf(heir.address);

    expect(await vault.inheritanceStatus()).to.equal(1); // Released
    expect(heirBalAfter - heirBalBefore).to.equal(net);
    expect(await token.balanceOf(vaultAddress)).to.equal(0n);
  });

  it("tras cancelar, no se puede hacer claim (Not active)", async function () {
    const deposit = ethers.parseUnits("1", 18);
    await token.connect(testator).approve(vaultAddress, deposit);
    await vault.connect(testator).registerInheritance(heir.address, deposit);

    await vault.connect(testator).cancelInheritance();

    // Adelantamos tiempo para que pase el require de 'Testator active'
    await time.increase(inactivityPeriod + 1);

    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Not active");
  });
});