const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ERC20InheritanceFactoryUSD6V2", function () {
  async function deployFactoryFixture() {
    const [deployer, testator1, testator2, commissionWallet, other] =
      await ethers.getSigners();

    // Mock token 6 decimales
    const MockToken = await ethers.getContractFactory("MockERC20USD6");
    const initialSupply = ethers.parseUnits("1000000000", 6); // 1,000,000,000
    const token = await MockToken.connect(deployer).deploy(
      "Mock USD6",
      "mUSD6",
      initialSupply
    );
    await token.waitForDeployment();

    const feeBps = 80; // 0.8% (por ejemplo)
    const minDeposit = ethers.parseUnits("10", 6); // mínimo neto 10 tokens

    const Factory = await ethers.getContractFactory(
      "ERC20InheritanceFactoryUSD6V2"
    );

    const factory = await Factory.deploy(
      commissionWallet.address,
      await token.getAddress(),
      feeBps,
      minDeposit
    );
    await factory.waitForDeployment();

    return {
      factory,
      token,
      deployer,
      testator1,
      testator2,
      commissionWallet,
      other,
      feeBps,
      minDeposit,
    };
  }

  it("constructor: inicializa parámetros correctamente", async function () {
    const {
      factory,
      token,
      commissionWallet,
      feeBps,
      minDeposit,
    } = await deployFactoryFixture();

    expect(await factory.commissionWallet()).to.equal(commissionWallet.address);
    expect(await factory.token()).to.equal(await token.getAddress());
    expect(await factory.feeBps()).to.equal(feeBps);
    expect(await factory.minDeposit()).to.equal(minDeposit);

    const [tok, bps, minDep] = await factory.factoryStaticParams();
    expect(tok).to.equal(await token.getAddress());
    expect(bps).to.equal(feeBps);
    expect(minDep).to.equal(minDeposit);
  });

  it("constructor: revierte con commissionWallet o token inválidos o fee demasiado alto", async function () {
    const [, , , commissionWallet] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockERC20USD6");
    const token = await MockToken.deploy(
      "Mock USD6",
      "mUSD6",
      ethers.parseUnits("1000", 6)
    );
    await token.waitForDeployment();

    const Factory = await ethers.getContractFactory(
      "ERC20InheritanceFactoryUSD6V2"
    );

    // commissionWallet = 0
    await expect(
      Factory.deploy(
        ethers.ZeroAddress,
        await token.getAddress(),
        50,
        ethers.parseUnits("10", 6)
      )
    ).to.be.revertedWith("Invalid commission wallet");

    // token = 0
    await expect(
      Factory.deploy(
        commissionWallet.address,
        ethers.ZeroAddress,
        50,
        ethers.parseUnits("10", 6)
      )
    ).to.be.revertedWith("Invalid token");

    // feeBps >= 100%
    await expect(
      Factory.deploy(
        commissionWallet.address,
        await token.getAddress(),
        10_000,
        ethers.parseUnits("10", 6)
      )
    ).to.be.revertedWith("fee too high");

    // token no es contrato → usamos una EOA cualquiera
    const [, eoa] = await ethers.getSigners();
    await expect(
      Factory.deploy(
        commissionWallet.address,
        eoa.address,
        50,
        ethers.parseUnits("10", 6)
      )
    ).to.be.revertedWith("Token not a contract");
  });

  it("createInheritanceVault: crea vault con parámetros correctos y lo indexa", async function () {
    const {
      factory,
      token,
      testator1,
      commissionWallet,
      feeBps,
      minDeposit,
    } = await deployFactoryFixture();

    const inactivityPeriod = 30 * 24 * 60 * 60; // 30 días

    const tx = await factory
      .connect(testator1)
      .createInheritanceVault(inactivityPeriod);

    await expect(tx)
      .to.emit(factory, "VaultCreated")
      .withArgs(testator1.address, anyAddress()); // matcher helper abajo

    // Leer desde allVaults[0]
    const vaultAddress = await factory.allVaults(0);
    expect(vaultAddress).to.properAddress;

    // Instanciar el vault en esa dirección
    const Vault = await ethers.getContractFactory("ERC20InheritanceVaultUSD6V2");
    const vault = Vault.attach(vaultAddress);

    expect(await vault.testator()).to.equal(testator1.address);
    expect(await vault.commissionWallet()).to.equal(commissionWallet.address);
    expect(await vault.token()).to.equal(await token.getAddress());
    expect(await vault.feeBps()).to.equal(feeBps);
    expect(await vault.minDeposit()).to.equal(minDeposit);
    expect(await vault.inactivityPeriod()).to.equal(inactivityPeriod);

    // Indexación por testador
    const listByTestator = await factory.getVaultsByTestator(testator1.address);
    expect(listByTestator.length).to.equal(1);
    expect(listByTestator[0]).to.equal(vaultAddress);

    const allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(1);
    expect(allVaults[0]).to.equal(vaultAddress);
  });

  it("createInheritanceVault: revierte con inactivityPeriod = 0", async function () {
    const { factory, testator1 } = await deployFactoryFixture();

    await expect(
      factory.connect(testator1).createInheritanceVault(0)
    ).to.be.revertedWith("Invalid inactivity");
  });

  it("crea múltiples vaults para distintos testadores y los indexa correctamente", async function () {
    const { factory, testator1, testator2 } = await deployFactoryFixture();

    const inactivity1 = 15 * 24 * 60 * 60; // 15 días
    const inactivity2 = 60 * 24 * 60 * 60; // 60 días

    await factory.connect(testator1).createInheritanceVault(inactivity1);
    await factory.connect(testator1).createInheritanceVault(inactivity2);
    await factory.connect(testator2).createInheritanceVault(inactivity1);

    // allVaults
    const allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(3);

    // Por testador
    const t1Vaults = await factory.getVaultsByTestator(testator1.address);
    const t2Vaults = await factory.getVaultsByTestator(testator2.address);

    expect(t1Vaults.length).to.equal(2);
    expect(t2Vaults.length).to.equal(1);

    // Chequeo básico de que no estén vacías
    expect(t1Vaults[0]).to.properAddress;
    expect(t2Vaults[0]).to.properAddress;
  });
});

/**
 * Helper para withArgs cuando sólo queremos validar que es una address
 * sin fijar el valor exacto.
 */
function anyAddress() {
  return (value) => {
    // string tipo "0x..."
    expect(ethers.isAddress(value)).to.equal(true);
    return true;
  };
}