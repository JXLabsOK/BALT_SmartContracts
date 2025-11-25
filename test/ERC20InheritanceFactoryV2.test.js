// test/ERC20InheritanceFactoryV2.test.js
const { expect } = require("chai");
const hre = require("hardhat");

describe("ERC20InheritanceFactoryV2", function () {
  let deployer, commission, user1, user2, other;
  let token;
  let factory;
  let factoryAddr;

  const FEE_BPS = 50; // 0.5%
  let UNIT;
  let MIN_DEPOSIT;

  beforeEach(async () => {
    [deployer, commission, user1, user2, other] = await hre.ethers.getSigners();

    UNIT = hre.ethers.parseUnits("1", 18);
    MIN_DEPOSIT = UNIT * 10n; // 10 DoC net min

    // Deploy mock ERC20
    const MockToken = await hre.ethers.getContractFactory("MockERC20");
    token = await MockToken.deploy();
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    // Deploy factory
    const Factory = await hre.ethers.getContractFactory("ERC20InheritanceFactoryV2");
    factory = await Factory.connect(deployer).deploy(
      commission.address,
      tokenAddr,
      FEE_BPS,
      MIN_DEPOSIT
    );
    await factory.waitForDeployment();
    factoryAddr = await factory.getAddress();
  });

  // ---------------- Constructor tests ----------------

  it("constructor sets immutable params correctly", async () => {
    expect(await factory.commissionWallet()).to.equal(commission.address);
    expect(await factory.token()).to.equal(await token.getAddress());
    expect(await factory.feeBps()).to.equal(FEE_BPS);
    expect(await factory.minDeposit()).to.equal(MIN_DEPOSIT);

    const [tokenRet, feeRet, minDepRet] = await factory.factoryStaticParams();
    expect(tokenRet).to.equal(await token.getAddress());
    expect(feeRet).to.equal(FEE_BPS);
    expect(minDepRet).to.equal(MIN_DEPOSIT);
  });

  it("constructor reverts if commissionWallet is zero", async () => {
    const Factory = await hre.ethers.getContractFactory("ERC20InheritanceFactoryV2");
    const tokenAddr = await token.getAddress();

    await expect(
      Factory.connect(deployer).deploy(
        hre.ethers.ZeroAddress,
        tokenAddr,
        FEE_BPS,
        MIN_DEPOSIT
      )
    ).to.be.revertedWith("Invalid commission wallet");
  });

  it("constructor reverts if token is zero", async () => {
    const Factory = await hre.ethers.getContractFactory("ERC20InheritanceFactoryV2");

    await expect(
      Factory.connect(deployer).deploy(
        commission.address,
        hre.ethers.ZeroAddress,
        FEE_BPS,
        MIN_DEPOSIT
      )
    ).to.be.revertedWith("Invalid token");
  });

  it("constructor reverts if feeBps >= 10_000", async () => {
    const Factory = await hre.ethers.getContractFactory("ERC20InheritanceFactoryV2");
    const tokenAddr = await token.getAddress();

    await expect(
      Factory.connect(deployer).deploy(
        commission.address,
        tokenAddr,
        10_000, // 100%
        MIN_DEPOSIT
      )
    ).to.be.revertedWith("fee too high");
  });

  it("constructor reverts if token is not a contract", async () => {
    const Factory = await hre.ethers.getContractFactory("ERC20InheritanceFactoryV2");

    // use user1 EOA as "token"
    await expect(
      Factory.connect(deployer).deploy(
        commission.address,
        user1.address,
        FEE_BPS,
        MIN_DEPOSIT
      )
    ).to.be.revertedWith("Token not a contract");
  });

  // ---------------- createInheritanceVault tests ----------------

  it("createInheritanceVault deploys a new vault with correct params and records it", async () => {
    const INACTIVITY = 60 * 60 * 24 * 30; // 30 days

    // Initially empty
    let allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(0);

    // Create vault from user1
    const tx = await factory.connect(user1).createInheritanceVault(INACTIVITY);

    // Evento VaultCreated
    await expect(tx)
      .to.emit(factory, "VaultCreated");

    // Ahora debe haber 1 vault en allVaults
    allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(1);

    const vaultAddr = allVaults[0];
    expect(vaultAddr).to.properAddress;

    // getVaultsByTestator para user1
    const vaultsUser1 = await factory.getVaultsByTestator(user1.address);
    expect(vaultsUser1.length).to.equal(1);
    expect(vaultsUser1[0]).to.equal(vaultAddr);

    // Ningún vault para user2 aún
    const vaultsUser2 = await factory.getVaultsByTestator(user2.address);
    expect(vaultsUser2.length).to.equal(0);

    // Verificamos que el vault tiene los parámetros correctos
    const vault = await hre.ethers.getContractAt("ERC20InheritanceVaultV2", vaultAddr);

    expect(await vault.testator()).to.equal(user1.address);
    expect(await vault.commissionWallet()).to.equal(commission.address);
    expect(await vault.token()).to.equal(await token.getAddress());
    expect(await vault.feeBps()).to.equal(FEE_BPS);
    expect(await vault.minDeposit()).to.equal(MIN_DEPOSIT);
    expect(await vault.inactivityPeriod()).to.equal(INACTIVITY);

    const status = await vault.inheritanceStatus();
    expect(status).to.equal(0); // Status.Active
  });

  it("createInheritanceVault: allows multiple vaults per testator and tracks them in order", async () => {
    const INACT1 = 10;
    const INACT2 = 20;

    await factory.connect(user1).createInheritanceVault(INACT1);
    await factory.connect(user1).createInheritanceVault(INACT2);

    const vaultsUser1 = await factory.getVaultsByTestator(user1.address);
    expect(vaultsUser1.length).to.equal(2);

    const allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(2);

    expect(allVaults[0]).to.equal(vaultsUser1[0]);
    expect(allVaults[1]).to.equal(vaultsUser1[1]);

    // Revisamos los inactivityPeriod de cada vault
    const v1 = await hre.ethers.getContractAt("ERC20InheritanceVaultV2", vaultsUser1[0]);
    const v2 = await hre.ethers.getContractAt("ERC20InheritanceVaultV2", vaultsUser1[1]);

    expect(await v1.inactivityPeriod()).to.equal(INACT1);
    expect(await v2.inactivityPeriod()).to.equal(INACT2);
  });

  it("createInheritanceVault: handles different testators separately in vaultsByTestator", async () => {
    const INACT1 = 100;
    const INACT2 = 200;

    await factory.connect(user1).createInheritanceVault(INACT1);
    await factory.connect(user2).createInheritanceVault(INACT2);

    const vaultsUser1 = await factory.getVaultsByTestator(user1.address);
    const vaultsUser2 = await factory.getVaultsByTestator(user2.address);
    const allVaults = await factory.getAllVaults();

    expect(vaultsUser1.length).to.equal(1);
    expect(vaultsUser2.length).to.equal(1);
    expect(allVaults.length).to.equal(2);

    expect(allVaults[0]).to.equal(vaultsUser1[0]);
    expect(allVaults[1]).to.equal(vaultsUser2[0]);

    const v1 = await hre.ethers.getContractAt("ERC20InheritanceVaultV2", vaultsUser1[0]);
    const v2 = await hre.ethers.getContractAt("ERC20InheritanceVaultV2", vaultsUser2[0]);

    expect(await v1.testator()).to.equal(user1.address);
    expect(await v2.testator()).to.equal(user2.address);
  });

  it("createInheritanceVault reverts if inactivityPeriod is zero", async () => {
    await expect(
      factory.connect(user1).createInheritanceVault(0)
    ).to.be.revertedWith("Invalid inactivity");
  });

  it("getVaultsByTestator returns empty array for addresses with no vaults", async () => {
    const result = await factory.getVaultsByTestator(other.address);
    expect(result.length).to.equal(0);
  });
});