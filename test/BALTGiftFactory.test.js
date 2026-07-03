const { expect } = require("chai");
const hre = require("hardhat");

const ethers = hre.ethers;
const isAddress = ethers.isAddress;

describe("BALTGiftFactory", function () {
  let creator, other;
  let factory;

  const releaseDelay = 60 * 60 * 24 * 30;

  async function getFutureReleaseTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp + releaseDelay;
  }

  async function createVaultAndGetAddress(selectedCreator, selectedReleaseTimestamp) {
    const tx = await factory
      .connect(selectedCreator)
      .createGiftVault(selectedReleaseTimestamp);

    const receipt = await tx.wait();

    const giftVaultCreatedEvent = receipt.logs.find(
      (log) => log.fragment && log.fragment.name === "GiftVaultCreated"
    );

    expect(giftVaultCreatedEvent).to.exist;

    return {
      receipt,
      event: giftVaultCreatedEvent,
      vaultAddress: giftVaultCreatedEvent.args.vaultAddress,
    };
  }

  beforeEach(async () => {
    [creator, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("BALTGiftFactory");
    factory = await Factory.connect(creator).deploy(creator.address);
    await factory.waitForDeployment();
  });

  it("should deploy a Gift Vault implementation when the Factory is deployed", async function () {
    const implementation = await factory.giftVaultImplementation();

    expect(isAddress(implementation)).to.be.true;
    expect(implementation).to.not.equal(ethers.ZeroAddress);

    const code = await ethers.provider.getCode(implementation);
    expect(code).to.not.equal("0x");
  });

  it("should lock the implementation contract and prevent direct initialization", async function () {
    const implementationAddress = await factory.giftVaultImplementation();

    const Vault = await ethers.getContractFactory("BALTGiftVault");
    const implementation = await Vault.attach(implementationAddress);

    const releaseTimestamp = await getFutureReleaseTimestamp();

    await expect(
      implementation.initialize(
        creator.address,
        releaseTimestamp,
        creator.address
      )
    ).to.be.revertedWith("Vault already initialized");
  });

  it("should create a new Gift Vault clone and emit GiftVaultCreated", async function () {
    const releaseTimestamp = await getFutureReleaseTimestamp();

    const { event, vaultAddress } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp
    );

    expect(isAddress(vaultAddress)).to.be.true;

    expect(event.args.creator).to.equal(creator.address);
    expect(event.args.releaseTimestamp).to.equal(BigInt(releaseTimestamp));
  });

  it("should initialize the created Gift Vault clone correctly", async function () {
    const releaseTimestamp = await getFutureReleaseTimestamp();

    const { vaultAddress } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp
    );

    const Vault = await ethers.getContractFactory("BALTGiftVault");
    const vault = await Vault.attach(vaultAddress);

    expect(await vault.creator()).to.equal(creator.address);
    expect(await vault.commissionWallet()).to.equal(creator.address);
    expect(await vault.releaseTimestamp()).to.equal(BigInt(releaseTimestamp));
    expect(await vault.createdAt()).to.be.gt(0);
    expect(await vault.giftStatus()).to.equal(0);
  });

  it("should fail if release timestamp is not in the future", async function () {
    const block = await ethers.provider.getBlock("latest");

    await expect(
      factory.connect(creator).createGiftVault(block.timestamp)
    ).to.be.revertedWith("Invalid release timestamp");
  });

  it("should fail if registerGift is sent with zero value", async function () {
    const releaseTimestamp = await getFutureReleaseTimestamp();

    const { vaultAddress } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp
    );

    const Vault = await ethers.getContractFactory("BALTGiftVault");
    const vault = await Vault.attach(vaultAddress);

    await expect(
      vault.connect(creator).registerGift(other.address, { value: 0 })
    ).to.be.revertedWith("Must deposit funds for gift");
  });

  it("should create unique Gift Vault addresses", async function () {
    const releaseTimestamp1 = await getFutureReleaseTimestamp();
    const releaseTimestamp2 = releaseTimestamp1 + 1;

    const { vaultAddress: address1 } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp1
    );

    const { vaultAddress: address2 } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp2
    );

    expect(address1).to.not.equal(address2);
  });

  it("should return the address of the newly created Gift Vault", async function () {
    const releaseTimestamp = await getFutureReleaseTimestamp();

    const expectedAddress = await ethers.provider.call({
      from: creator.address,
      to: factory.target,
      data: factory.interface.encodeFunctionData("createGiftVault", [
        releaseTimestamp,
      ]),
    }).then((result) =>
      factory.interface.decodeFunctionResult("createGiftVault", result)[0]
    );

    const { vaultAddress: actualAddress } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp
    );

    expect(actualAddress).to.equal(expectedAddress);
  });

  it("should return gift vaults by creator", async function () {
    const releaseTimestamp = await getFutureReleaseTimestamp();

    const { vaultAddress } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp
    );

    const vaults = await factory
      .connect(other)
      .getGiftVaultsByCreator(creator.address);

    expect(vaults.length).to.equal(1);
    expect(vaults[0]).to.equal(vaultAddress);
  });

  it("should include the new Gift Vault in giftVaultsByCreator mapping", async function () {
    const releaseTimestamp = await getFutureReleaseTimestamp();

    const { vaultAddress } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp
    );

    const vaults = await factory.getGiftVaultsByCreator(creator.address);

    expect(vaults).to.include(vaultAddress);
  });

  it("should return all created Gift Vaults", async function () {
    const releaseTimestamp1 = await getFutureReleaseTimestamp();
    const releaseTimestamp2 = releaseTimestamp1 + 1;

    await createVaultAndGetAddress(creator, releaseTimestamp1);
    await createVaultAndGetAddress(creator, releaseTimestamp2);

    const allGiftVaults = await factory.getAllGiftVaults();

    expect(allGiftVaults.length).to.equal(2);

    allGiftVaults.forEach((addr) => {
      expect(isAddress(addr)).to.be.true;
    });
  });

  it("should track Gift Vaults separately by creator", async function () {
    const releaseTimestamp1 = await getFutureReleaseTimestamp();
    const releaseTimestamp2 = releaseTimestamp1 + 1;

    const { vaultAddress: creatorVault } = await createVaultAndGetAddress(
      creator,
      releaseTimestamp1
    );

    const { vaultAddress: otherVault } = await createVaultAndGetAddress(
      other,
      releaseTimestamp2
    );

    const creatorVaults = await factory.getGiftVaultsByCreator(creator.address);
    const otherVaults = await factory.getGiftVaultsByCreator(other.address);

    expect(creatorVaults.length).to.equal(1);
    expect(otherVaults.length).to.equal(1);

    expect(creatorVaults[0]).to.equal(creatorVault);
    expect(otherVaults[0]).to.equal(otherVault);
  });

  // BΔLT-GIFT-005
  it("should revert if deployed with a zero commission wallet address", async function () {
    const Factory = await ethers.getContractFactory("BALTGiftFactory");

    await expect(
      Factory.deploy(ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid commission wallet");
  });
  // BΔLT-GIFT-005 END
});