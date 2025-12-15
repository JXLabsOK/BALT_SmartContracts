const { expect } = require("chai");
const hre = require("hardhat");

describe("ERC20InheritanceFactoryWBTCV2", function () {
  let deployer, commission, user1, user2, other;
  let wbtcToken;
  let factory;

  const FEE_BPS = 50; // 0.5%
  let UNIT;
  let MIN_DEPOSIT;

  beforeEach(async () => {
    [deployer, commission, user1, user2, other] =
      await hre.ethers.getSigners();

    // WBTC tiene 8 decimales
    UNIT = hre.ethers.parseUnits("1", 8);
    MIN_DEPOSIT = UNIT * 10n; // 10 WBTC net min (solo para test)

    // Deploy mock ERC20 tipo WBTC (8 decimales)
    const MockWBTC = await hre.ethers.getContractFactory(
      "MockERC20Decimals8"
    );
    wbtcToken = await MockWBTC.deploy();
    await wbtcToken.waitForDeployment();
    const tokenAddr = await wbtcToken.getAddress();

    // Deploy factory específica de WBTC
    const Factory = await hre.ethers.getContractFactory(
      "ERC20InheritanceFactoryWBTCV2"
    );
    factory = await Factory.connect(deployer).deploy(
      commission.address,
      tokenAddr,
      FEE_BPS,
      MIN_DEPOSIT
    );
    await factory.waitForDeployment();
  });

  // ---------------- Constructor tests ----------------

  it("constructor sets immutable params correctly", async () => {
    expect(await factory.commissionWallet()).to.equal(commission.address);
    expect(await factory.token()).to.equal(await wbtcToken.getAddress());
    expect(await factory.feeBps()).to.equal(FEE_BPS);
    expect(await factory.minDeposit()).to.equal(MIN_DEPOSIT);

    const [tokenRet, feeRet, minDepRet] =
      await factory.factoryStaticParams();
    expect(tokenRet).to.equal(await wbtcToken.getAddress());
    expect(feeRet).to.equal(FEE_BPS);
    expect(minDepRet).to.equal(MIN_DEPOSIT);
  });

  it("constructor reverts if commissionWallet is zero", async () => {
    const Factory = await hre.ethers.getContractFactory(
      "ERC20InheritanceFactoryWBTCV2"
    );
    const tokenAddr = await wbtcToken.getAddress();

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
    const Factory = await hre.ethers.getContractFactory(
      "ERC20InheritanceFactoryWBTCV2"
    );

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
    const Factory = await hre.ethers.getContractFactory(
      "ERC20InheritanceFactoryWBTCV2"
    );
    const tokenAddr = await wbtcToken.getAddress();

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
    const Factory = await hre.ethers.getContractFactory(
      "ERC20InheritanceFactoryWBTCV2"
    );

    await expect(
      Factory.connect(deployer).deploy(
        commission.address,
        user1.address, // EOA
        FEE_BPS,
        MIN_DEPOSIT
      )
    ).to.be.revertedWith("Token not a contract");
  });

  // ---------------- createInheritanceVault tests ----------------

  it("createInheritanceVault deploys a new WBTC vault with correct params and records it", async () => {
    const INACTIVITY = 60 * 60 * 24 * 30; // 30 days

    let allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(0);

    const tx = await factory
      .connect(user1)
      .createInheritanceVault(INACTIVITY);

    await expect(tx).to.emit(factory, "VaultCreated");

    allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(1);

    const vaultAddr = allVaults[0];
    expect(vaultAddr).to.be.properAddress;

    const vaultsUser1 = await factory.getVaultsByTestator(user1.address);
    expect(vaultsUser1.length).to.equal(1);
    expect(vaultsUser1[0]).to.equal(vaultAddr);

    const vaultsUser2 = await factory.getVaultsByTestator(user2.address);
    expect(vaultsUser2.length).to.equal(0);

    const vault = await hre.ethers.getContractAt(
      "ERC20InheritanceVaultWBTCV2",
      vaultAddr
    );

    expect(await vault.testator()).to.equal(user1.address);
    expect(await vault.commissionWallet()).to.equal(commission.address);
    expect(await vault.token()).to.equal(await wbtcToken.getAddress());
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

    const v1 = await hre.ethers.getContractAt(
      "ERC20InheritanceVaultWBTCV2",
      vaultsUser1[0]
    );
    const v2 = await hre.ethers.getContractAt(
      "ERC20InheritanceVaultWBTCV2",
      vaultsUser1[1]
    );

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

    const v1 = await hre.ethers.getContractAt(
      "ERC20InheritanceVaultWBTCV2",
      vaultsUser1[0]
    );
    const v2 = await hre.ethers.getContractAt(
      "ERC20InheritanceVaultWBTCV2",
      vaultsUser2[0]
    );

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

  it("reverts when creating a vault if the token does not have 8 decimals", async () => {
    // Mock token con 18 decimales (tipo ERC20 estándar)
    const MockToken18 = await hre.ethers.getContractFactory("MockERC20");
    const token18 = await MockToken18.deploy();
    await token18.waitForDeployment();
    const token18Addr = await token18.getAddress();

    const Factory = await hre.ethers.getContractFactory(
      "ERC20InheritanceFactoryWBTCV2"
    );

    // Factory se despliega igual (solo chequea que sea contrato)
    const factoryBad = await Factory.connect(deployer).deploy(
      commission.address,
      token18Addr,
      FEE_BPS,
      MIN_DEPOSIT
    );
    await factoryBad.waitForDeployment();

    // Pero al crear el vault, el constructor del vault debe revertir
    await expect(
      factoryBad.connect(user1).createInheritanceVault(100)
    ).to.be.revertedWith("Token must have 8 decimals");
  });
});