const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("BALTGiftFactoryUSD6", function () {
    let deployer, creator, other, commissionWallet;
    let token, token18, factory;

    const initialSupply = ethers.parseUnits("1000000", 6);
    const releaseDelay = 60 * 60 * 24 * 30;

    async function getFutureReleaseTimestamp() {
        const block = await ethers.provider.getBlock("latest");
        return block.timestamp + releaseDelay;
    }

    async function createVaultAndGetAddress(selectedCreator, selectedReleaseTimestamp) {
        const tx = await factory.connect(selectedCreator).createGiftVault(selectedReleaseTimestamp);
        const receipt = await tx.wait();
        const event = receipt.logs.find((log) => log.fragment && log.fragment.name === "GiftVaultCreated");

        expect(event).to.exist;

        return {
            event,
            vaultAddress: event.args.vaultAddress,
        };
    }

    beforeEach(async () => {
        [deployer, creator, other, commissionWallet] = await ethers.getSigners();

        const MockUSD6 = await ethers.getContractFactory("MockERC20USD6");
        token = await MockUSD6.connect(deployer).deploy("Mock USDT", "mUSDT", initialSupply);
        await token.waitForDeployment();

        const Mock18 = await ethers.getContractFactory("MockERC20");
        token18 = await Mock18.connect(deployer).deploy();
        await token18.waitForDeployment();

        const Factory = await ethers.getContractFactory("BALTGiftFactoryUSD6");
        factory = await Factory.connect(deployer).deploy(commissionWallet.address, token.target);
        await factory.waitForDeployment();
    });

    it("should deploy with the expected immutable values", async function () {
        expect(await factory.commissionWallet()).to.equal(commissionWallet.address);
        expect(await factory.giftToken()).to.equal(token.target);
    });

    it("should deploy a Gift Vault implementation", async function () {
        const implementation = await factory.giftVaultImplementation();

        expect(ethers.isAddress(implementation)).to.be.true;
        expect(implementation).to.not.equal(ethers.ZeroAddress);
        expect(await ethers.provider.getCode(implementation)).to.not.equal("0x");
    });

    it("should lock the implementation contract and prevent direct initialization", async function () {
        const implementationAddress = await factory.giftVaultImplementation();
        const Vault = await ethers.getContractFactory("BALTGiftVaultUSD6");
        const implementation = Vault.attach(implementationAddress);
        const releaseTimestamp = await getFutureReleaseTimestamp();

        await expect(
            implementation.initialize(
                creator.address,
                token.target,
                releaseTimestamp,
                commissionWallet.address
            )
        ).to.be.revertedWith("Vault already initialized");
    });

    it("should create a new Gift Vault clone and emit GiftVaultCreated", async function () {
        const releaseTimestamp = await getFutureReleaseTimestamp();
        const { event, vaultAddress } = await createVaultAndGetAddress(creator, releaseTimestamp);

        expect(ethers.isAddress(vaultAddress)).to.be.true;
        expect(event.args.creator).to.equal(creator.address);
        expect(event.args.releaseTimestamp).to.equal(BigInt(releaseTimestamp));
    });

    it("should initialize the created Gift Vault clone correctly", async function () {
        const releaseTimestamp = await getFutureReleaseTimestamp();
        const { vaultAddress } = await createVaultAndGetAddress(creator, releaseTimestamp);

        const Vault = await ethers.getContractFactory("BALTGiftVaultUSD6");
        const vault = Vault.attach(vaultAddress);

        expect(await vault.creator()).to.equal(creator.address);
        expect(await vault.giftToken()).to.equal(token.target);
        expect(await vault.commissionWallet()).to.equal(commissionWallet.address);
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

    it("should create unique Gift Vault addresses", async function () {
        const releaseTimestamp1 = await getFutureReleaseTimestamp();
        const releaseTimestamp2 = releaseTimestamp1 + 1;

        const { vaultAddress: address1 } = await createVaultAndGetAddress(creator, releaseTimestamp1);
        const { vaultAddress: address2 } = await createVaultAndGetAddress(creator, releaseTimestamp2);

        expect(address1).to.not.equal(address2);
    });

    it("should return gift vaults by creator", async function () {
        const releaseTimestamp = await getFutureReleaseTimestamp();
        const { vaultAddress } = await createVaultAndGetAddress(creator, releaseTimestamp);

        const vaults = await factory.getGiftVaultsByCreator(creator.address);

        expect(vaults.length).to.equal(1);
        expect(vaults[0]).to.equal(vaultAddress);
    });

    it("should return all created Gift Vaults", async function () {
        const releaseTimestamp1 = await getFutureReleaseTimestamp();
        const releaseTimestamp2 = releaseTimestamp1 + 1;

        await createVaultAndGetAddress(creator, releaseTimestamp1);
        await createVaultAndGetAddress(other, releaseTimestamp2);

        const allGiftVaults = await factory.getAllGiftVaults();

        expect(allGiftVaults.length).to.equal(2);
        expect(ethers.isAddress(allGiftVaults[0])).to.be.true;
        expect(ethers.isAddress(allGiftVaults[1])).to.be.true;
    });

    it("should track Gift Vaults separately by creator", async function () {
        const releaseTimestamp1 = await getFutureReleaseTimestamp();
        const releaseTimestamp2 = releaseTimestamp1 + 1;

        const { vaultAddress: creatorVault } = await createVaultAndGetAddress(creator, releaseTimestamp1);
        const { vaultAddress: otherVault } = await createVaultAndGetAddress(other, releaseTimestamp2);

        const creatorVaults = await factory.getGiftVaultsByCreator(creator.address);
        const otherVaults = await factory.getGiftVaultsByCreator(other.address);

        expect(creatorVaults.length).to.equal(1);
        expect(otherVaults.length).to.equal(1);
        expect(creatorVaults[0]).to.equal(creatorVault);
        expect(otherVaults[0]).to.equal(otherVault);
    });

    it("should revert if deployed with a zero commission wallet address", async function () {
        const Factory = await ethers.getContractFactory("BALTGiftFactoryUSD6");

        await expect(
            Factory.deploy(ethers.ZeroAddress, token.target)
        ).to.be.revertedWith("Invalid commission wallet");
    });

    it("should revert if deployed with a zero gift token address", async function () {
        const Factory = await ethers.getContractFactory("BALTGiftFactoryUSD6");

        await expect(
            Factory.deploy(commissionWallet.address, ethers.ZeroAddress)
        ).to.be.revertedWith("Invalid gift token");
    });

    it("should revert if the gift token is not a contract", async function () {
        const Factory = await ethers.getContractFactory("BALTGiftFactoryUSD6");

        await expect(
            Factory.deploy(commissionWallet.address, other.address)
        ).to.be.revertedWith("Gift token must be contract");
    });

    it("should revert if the gift token does not have 6 decimals", async function () {
        const Factory = await ethers.getContractFactory("BALTGiftFactoryUSD6");

        await expect(
            Factory.deploy(commissionWallet.address, token18.target)
        ).to.be.revertedWith("Token must have 6 decimals");
    });
});
