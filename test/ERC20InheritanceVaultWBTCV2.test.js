// test/ERC20InheritanceVaultWBTCV2.test.js
const { expect } = require("chai");
const hre = require("hardhat");

describe("ERC20InheritanceVaultWBTCV2", function () {
  let deployer, commission, testator, heir, other;
  let token;
  let vault;
  let vaultAddr;

  // Config
  const FEE_BPS = 50; // 0.5%
  const INACTIVITY = 30 * 24 * 60 * 60; // 30 days

  let UNIT;
  let MIN_DEPOSIT;
  const BPS_DENOM = 10_000n;

  beforeEach(async () => {
    [deployer, commission, testator, heir, other] =
        await hre.ethers.getSigners();

    // 1 WBTC (8 decimales)
    UNIT = hre.ethers.parseUnits("1", 8);

    // Mínimo neto de herencia (por ejemplo 0.001 WBTC)
    MIN_DEPOSIT = hre.ethers.parseUnits("0.001", 8);

    // Deploy mock token tipo WBTC (8 decimales)
    const MockWBTC = await hre.ethers.getContractFactory("MockERC20Decimals8");
    token = await MockWBTC.deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    // ⚠️ IMPORTANTE: minteamos directamente al testator,
    // igual que hacías en el test de ERC20InheritanceVaultV2
    const initialMint = hre.ethers.parseUnits("1000000", 8); // 1M WBTC de prueba
    await token.mint(testator.address, initialMint);

    // Deploy vault WBTC
    const Vault = await hre.ethers.getContractFactory(
        "ERC20InheritanceVaultWBTCV2"
    );
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

    // Approve vault para mover fondos del testator
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

  it("registerInheritance: free tier (<= 0.01 WBTC) charges 0 fee and keeps full amount", async () => {
    // Free tier en el contrato: <= 0.01 WBTC
    const deposit = hre.ethers.parseUnits("0.005", 8); // 0.005 WBTC (debajo del free tier)
    const testatorBalanceBefore = await token.balanceOf(testator.address);

    const tx = await vault
      .connect(testator)
      .registerInheritance(heir.address, deposit);

    // Evento InheritanceRegistered con el importe neto (igual al depósito en free tier)
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

    expect(vaultBal).to.equal(deposit); // todo el depósito queda en el vault
    expect(commissionBal).to.equal(0); // sin fee
    expect(testatorBalanceBefore - testatorBalanceAfter).to.equal(deposit);

    // Estado del vault
    expect(await vault.heir()).to.equal(heir.address);
    expect(await vault.inheritanceAmount()).to.equal(deposit);

    const details = await vault.getInheritanceDetails();
    expect(details[0]).to.equal(heir.address);
    expect(details[1]).to.equal(deposit);
  });

  it("registerInheritance: above free tier, applies fee and keeps net amount in vault (Tier1)", async () => {
    // > 0.01 WBTC y << 5 WBTC → Tier1 con feeBps completo
    const deposit = hre.ethers.parseUnits("0.02", 8); // 0.02 WBTC

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

    // Sólo verificamos que FeeApplied se emite
    await expect(tx).to.emit(vault, "FeeApplied");

    const vaultBal = await token.balanceOf(vaultAddr);
    const commissionBal = await token.balanceOf(commission.address);
    const testatorAfter = await token.balanceOf(testator.address);

    expect(vaultBal).to.equal(net);
    expect(commissionBal).to.equal(fee);
    expect(testatorBefore - testatorAfter).to.equal(deposit);

    expect(await vault.inheritanceAmount()).to.equal(net);
  });

  it("registerInheritance: reverts if caller is not testator", async () => {
    const deposit = hre.ethers.parseUnits("0.01", 8);

    await expect(
      vault.connect(other).registerInheritance(heir.address, deposit)
    ).to.be.revertedWith("Only the testator can register");
  });

  it("registerInheritance: reverts if heir is zero", async () => {
    const deposit = hre.ethers.parseUnits("0.01", 8);

    await expect(
      vault
        .connect(testator)
        .registerInheritance(hre.ethers.ZeroAddress, deposit)
    ).to.be.revertedWith("Invalid heir address");
  });

  it("registerInheritance: reverts if depositAmount is zero", async () => {
    await expect(
      vault.connect(testator).registerInheritance(heir.address, 0)
    ).to.be.revertedWith("Must deposit funds");
  });

  it("registerInheritance: reverts if deposit does not reach minDeposit after fee", async () => {
    // Creamos un vault con minDeposit alto para probar el require
    const HIGH_MIN_DEPOSIT = hre.ethers.parseUnits("0.5", 8); // 0.5 WBTC net

    const Vault = await hre.ethers.getContractFactory(
      "ERC20InheritanceVaultWBTCV2"
    );
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

    await token
      .connect(testator)
      .approve(vault2Addr, hre.ethers.parseUnits("10", 8));

    // 0.01 WBTC = límite superior del free tier → fee = 0, net = 0.01 WBTC < 0.5 WBTC
    const deposit = hre.ethers.parseUnits("0.01", 8);

    const balanceBefore = await token.balanceOf(testator.address);

    await expect(
      vault2.connect(testator).registerInheritance(heir.address, deposit)
    ).to.be.revertedWith("Deposit too small");

    // Aseguramos que el revert no movió fondos
    const balanceAfter = await token.balanceOf(testator.address);
    expect(balanceAfter).to.equal(balanceBefore);
  });

  it("registerInheritance: cannot be called twice (heir already set)", async () => {
    const deposit = hre.ethers.parseUnits("0.02", 8);

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
    const deposit = hre.ethers.parseUnits("0.02", 8);
    const fee = (deposit * BigInt(FEE_BPS)) / BPS_DENOM;
    const net = deposit - fee;

    // register
    await vault.connect(testator).registerInheritance(heir.address, deposit);

    // only testator
    await expect(
      vault.connect(other).cancelInheritance()
    ).to.be.revertedWith("Only testator");

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
    // comisión se mantiene
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
    const deposit = hre.ethers.parseUnits("0.02", 8);
    const fee = (deposit * BigInt(FEE_BPS)) / BPS_DENOM;
    const net = deposit - fee;

    await vault.connect(testator).registerInheritance(heir.address, deposit);

    // no puede reclamar antes de tiempo
    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Testator active");

    // adelantamos el tiempo
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
    const deposit = hre.ethers.parseUnits("0.005", 8); // free tier

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