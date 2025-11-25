// test/ERC20InheritanceVaultV2.test.js
const { expect } = require("chai");
const hre = require("hardhat");

describe("ERC20InheritanceVaultV2", function () {
  let deployer, commission, testator, heir, other;
  let token;
  let vault;
  let vaultAddr;

  // Config
  const FEE_BPS = 50; // 0.5%
  const INACTIVITY = 30 * 24 * 60 * 60; // 30 days

  // Estos los seteo en beforeEach con ethers.parseUnits
  let UNIT;
  let MIN_DEPOSIT;
  const BPS_DENOM = 10_000n;
  const FREE_TIER_MAX_DOC = 1_000n; // 1,000 DoC (en unidades enteras)

  beforeEach(async () => {
    [deployer, commission, testator, heir, other] = await hre.ethers.getSigners();

    UNIT = hre.ethers.parseUnits("1", 18);      // 1 DoC
    MIN_DEPOSIT = UNIT * 10n;                  // 10 DoC neto min

    // Deploy mock token
    const MockToken = await hre.ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    // Mint tokens to testator
    const initialMint = UNIT * 1_000_000n; // 1M DoC
    await token.mint(testator.address, initialMint);

    // Deploy vault
    const Vault = await hre.ethers.getContractFactory("ERC20InheritanceVaultV2");
    vault = await Vault.connect(deployer).deploy(
      testator.address,
      INACTIVITY,
      commission.address,
      tokenAddr,
      FEE_BPS,
      MIN_DEPOSIT
    );
    await vault.waitForDeployment();
    vaultAddr = await vault.getAddress();

    // Approve vault to pull tokens from testator
    await token.connect(testator).approve(vaultAddr, initialMint);
  });

  it("constructor sets immutable params correctly", async () => {
    expect(await vault.testator()).to.equal(testator.address);
    expect(await vault.commissionWallet()).to.equal(commission.address);
    expect(await vault.token()).to.equal(await token.getAddress());
    expect(await vault.feeBps()).to.equal(FEE_BPS);
    expect(await vault.minDeposit()).to.equal(MIN_DEPOSIT);
    expect(await vault.inactivityPeriod()).to.equal(INACTIVITY);

    const status = await vault.inheritanceStatus();
    expect(status).to.equal(0); // Status.Active
  });

  it("registerInheritance: free tier (<= 1000 DoC) charges 0 fee and keeps full amount", async () => {
    const deposit = UNIT * 500n; // 500 DoC (under free tier)
    const testatorBalanceBefore = await token.balanceOf(testator.address);

    const tx = await vault
      .connect(testator)
      .registerInheritance(heir.address, deposit);

    // Evento InheritanceRegistered
    await expect(tx)
      .to.emit(vault, "InheritanceRegistered")
      .withArgs(testator.address, heir.address, deposit, INACTIVITY);

    // FeeApplied debe existir, pero con fee 0 y bps=0 en free tier
    await expect(tx)
      .to.emit(vault, "FeeApplied")
      .withArgs(testator.address, 0, 0, 0, deposit);

    // Balances
    const vaultBal = await token.balanceOf(vaultAddr);
    const commissionBal = await token.balanceOf(commission.address);
    const testatorBalanceAfter = await token.balanceOf(testator.address);

    expect(vaultBal).to.equal(deposit);        // todo el depósito queda en el vault
    expect(commissionBal).to.equal(0);        // sin fee
    expect(testatorBalanceBefore - testatorBalanceAfter).to.equal(deposit);

    // Estado del vault
    expect(await vault.heir()).to.equal(heir.address);
    expect(await vault.inheritanceAmount()).to.equal(deposit);

    const details = await vault.getInheritanceDetails();
    expect(details[0]).to.equal(heir.address);
    expect(details[1]).to.equal(deposit);
  });

  it("registerInheritance: above free tier, applies fee and cap correctly (Tier1)", async () => {
    // 2,000 DoC -> free tier = 1,000 DoC, so this pays fee
    const deposit = UNIT * 2000n;

    // fee = deposit * 50 bps / 10_000
    const fee = (deposit * BigInt(FEE_BPS)) / BPS_DENOM;
    const net = deposit - fee;

    const testatorBefore = await token.balanceOf(testator.address);

    const tx = await vault
      .connect(testator)
      .registerInheritance(heir.address, deposit);

    // InheritanceRegistered con el neto
    await expect(tx)
      .to.emit(vault, "InheritanceRegistered")
      .withArgs(testator.address, heir.address, net, INACTIVITY);

    // Sólo verificamos que FeeApplied se emite (los detalles los chequeamos con balances)
    await expect(tx)
      .to.emit(vault, "FeeApplied");

    // Chequeo de balances: lo importante del modelo de comisión
    const vaultBal = await token.balanceOf(vaultAddr);
    const commissionBal = await token.balanceOf(commission.address);
    const testatorAfter = await token.balanceOf(testator.address);

    expect(vaultBal).to.equal(net);
    expect(commissionBal).to.equal(fee);
    expect(testatorBefore - testatorAfter).to.equal(deposit);

    expect(await vault.inheritanceAmount()).to.equal(net);
  });

  it("registerInheritance: reverts if caller is not testator", async () => {
    const deposit = UNIT * 100n;

    await expect(
      vault.connect(other).registerInheritance(heir.address, deposit)
    ).to.be.revertedWith("Only the testator can register");
  });

  it("registerInheritance: reverts if heir is zero", async () => {
    const deposit = UNIT * 100n;

    await expect(
      vault.connect(testator).registerInheritance(hre.ethers.ZeroAddress, deposit)
    ).to.be.revertedWith("Invalid heir address");
  });

  it("registerInheritance: reverts if depositAmount is zero", async () => {
    await expect(
      vault.connect(testator).registerInheritance(heir.address, 0)
    ).to.be.revertedWith("Must deposit funds");
  });

  it("registerInheritance: reverts if deposit does not reach minDeposit after fee", async () => {
    // Creamos un vault con minDeposit alto para probar el require
    const HIGH_MIN_DEPOSIT = UNIT * 5_000n; // 5,000 DoC net
    const Vault = await hre.ethers.getContractFactory("ERC20InheritanceVaultV2");
    const tokenAddr = await token.getAddress();
    const vault2 = await Vault.connect(deployer).deploy(
      testator.address,
      INACTIVITY,
      commission.address,
      tokenAddr,
      FEE_BPS,
      HIGH_MIN_DEPOSIT
    );
    await vault2.waitForDeployment();
    const vault2Addr = await vault2.getAddress();

    await token.connect(testator).approve(vault2Addr, UNIT * 10_000n);

    const deposit = UNIT * 1_000n; // 1,000 DoC, debajo del min neto de 5,000

    const balanceBefore = await token.balanceOf(testator.address);

    await expect(
      vault2.connect(testator).registerInheritance(heir.address, deposit)
    ).to.be.revertedWith("Deposit too small");

    // Aseguramos que el revert no movió fondos
    const balanceAfter = await token.balanceOf(testator.address);
    expect(balanceAfter).to.equal(balanceBefore);
  });

  it("registerInheritance: cannot be called twice (heir already set)", async () => {
    const deposit = UNIT * 200n;

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    await expect(
      vault.connect(testator).registerInheritance(heir.address, deposit)
    ).to.be.revertedWith("Inheritance already registered");
  });

  it("performCheckIn: only testator can check in and updates lastCheckIn", async () => {
    await expect(
      vault.connect(other).performCheckIn()
    ).to.be.revertedWith("Only the testator");

    const before = await vault.lastCheckIn();

    await vault.connect(testator).performCheckIn();
    const after = await vault.lastCheckIn();

    expect(after).to.be.gt(before);
  });

  it("cancelInheritance: only testator, requires Active and non-zero balance, refunds vault balance", async () => {
    const deposit = UNIT * 2000n;
    const fee = (deposit * BigInt(FEE_BPS)) / BPS_DENOM;
    const net = deposit - fee;

    // register
    await vault.connect(testator).registerInheritance(heir.address, deposit);

    // only testator
    await expect(
      vault.connect(other).cancelInheritance()
    ).to.be.revertedWith("Only testator");

    // cancel
    const testatorBefore = await token.balanceOf(testator.address);
    const commissionBefore = await token.balanceOf(commission.address);

    await vault.connect(testator).cancelInheritance();

    const status = await vault.inheritanceStatus();
    expect(status).to.equal(2); // Status.Cancelled

    const vaultBal = await token.balanceOf(vaultAddr);
    const testatorAfter = await token.balanceOf(testator.address);
    const commissionAfter = await token.balanceOf(commission.address);

    expect(vaultBal).to.equal(0);
    // testator recupera el neto (deposit - fee)
    expect(testatorAfter - testatorBefore).to.equal(net);
    // comisión se mantiene (no se devuelve)
    expect(commissionAfter).to.equal(commissionBefore);

    // no se puede cancelar de nuevo
    await expect(
      vault.connect(testator).cancelInheritance()
    ).to.be.revertedWith("Not active");
  });

  it("cancelInheritance: reverts if no balance", async () => {
    await expect(
      vault.connect(testator).cancelInheritance()
    ).to.be.revertedWith("No balance");
  });

  it("claimInheritance: only heir, only after inactivity, only when Active, sends vault balance to heir", async () => {
    const deposit = UNIT * 2000n;
    const fee = (deposit * BigInt(FEE_BPS)) / BPS_DENOM;
    const net = deposit - fee;

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    // no puede reclamar antes de tiempo
    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Testator active");

    // adelantar tiempo
    await hre.network.provider.send("evm_increaseTime", [INACTIVITY + 1]);
    await hre.network.provider.send("evm_mine");

    // no-heir no puede reclamar
    await expect(
      vault.connect(other).claimInheritance()
    ).to.be.revertedWith("Only heir");

    const heirBefore = await token.balanceOf(heir.address);

    await vault.connect(heir).claimInheritance();

    const heirAfter = await token.balanceOf(heir.address);
    const vaultBal = await token.balanceOf(vaultAddr);
    const status = await vault.inheritanceStatus();

    expect(heirAfter - heirBefore).to.equal(net);
    expect(vaultBal).to.equal(0);
    expect(status).to.equal(1); // Status.Released

    // no se puede reclamar de nuevo
    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Not active");
  });

  it("getInheritanceDetails returns consistent info", async () => {
    const deposit = UNIT * 500n;

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    const [heirRet, amountRet, lastCheckIn, createdAt, status] =
      await vault.getInheritanceDetails();

    expect(heirRet).to.equal(heir.address);
    expect(amountRet).to.equal(deposit); // en free tier net = deposit
    expect(lastCheckIn).to.be.gt(0);
    expect(createdAt).to.be.gt(0);
    expect(status).to.equal(0); // Active
  });
});