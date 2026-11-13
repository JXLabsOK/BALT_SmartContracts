const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const units = (value) => ethers.parseUnits(String(value), 18);

async function advanceTo(timestamp) {
    await network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
    await network.provider.send("evm_mine");
}

describe("BALTGiftFactoryUSD18 / BALTGiftVaultUSD18", function () {
    let owner, beneficiary, outsider, commission;
    let token, factory;

    beforeEach(async function () {
        [owner, beneficiary, outsider, commission] = await ethers.getSigners();
        token = await ethers.deployContract("MockGiftTokenUSD18");
        await token.waitForDeployment();
        await token.mint(owner.address, units("100000"));
        factory = await ethers.deployContract("BALTGiftFactoryUSD18", [commission.address, await token.getAddress()]);
        await factory.waitForDeployment();
    });

    async function createVault(creator = owner, secondsFromNow = 3600) {
        const latest = await ethers.provider.getBlock("latest");
        const release = latest.timestamp + secondsFromNow;
        const transaction = await factory.connect(creator).createGiftVault(release);
        const receipt = await transaction.wait();
        const event = receipt.logs.map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find((log) => log?.name === "GiftVaultCreated");
        const address = event.args.vaultAddress;
        return { vault: await ethers.getContractAt("BALTGiftVaultUSD18", address), address, release };
    }

    async function register(vault, amount, to = beneficiary, from = owner, value = 0n) {
        await token.connect(from).approve(await vault.getAddress(), amount);
        return vault.connect(from).registerGift(to.address, amount, { value });
    }

    it("rejects invalid constructor parameters and token decimals", async function () {
        const sixDecimals = await ethers.deployContract("MockGiftTokenUSD6");
        await sixDecimals.waitForDeployment();
        const address = await token.getAddress();
        const Factory = await ethers.getContractFactory("BALTGiftFactoryUSD18");
        await expect(Factory.deploy(ethers.ZeroAddress, address)).to.be.revertedWith("Invalid commission wallet");
        await expect(Factory.deploy(commission.address, ethers.ZeroAddress)).to.be.revertedWith("Invalid gift token");
        await expect(Factory.deploy(commission.address, outsider.address)).to.be.revertedWith("Gift token must be contract");
        await expect(Factory.deploy(commission.address, await sixDecimals.getAddress())).to.be.revertedWith("Token must have 18 decimals");
    });

    it("creates isolated clones, locks implementation and exposes creator indexes", async function () {
        const first = await createVault();
        const second = await createVault(outsider);
        expect(first.address).to.not.equal(second.address);
        expect(await factory.giftToken()).to.equal(await token.getAddress());
        expect(await factory.commissionWallet()).to.equal(commission.address);
        expect(await first.vault.creator()).to.equal(owner.address);
        expect(await first.vault.giftToken()).to.equal(await token.getAddress());
        expect(await first.vault.commissionWallet()).to.equal(commission.address);
        expect(await first.vault.releaseTimestamp()).to.equal(first.release);
        expect(await first.vault.giftStatus()).to.equal(0);
        expect(await factory.getAllGiftVaults()).to.deep.equal([first.address, second.address]);
        expect(await factory.getGiftVaultsByCreator(owner.address)).to.deep.equal([first.address]);
        expect(await factory.getGiftVaultsByCreator(outsider.address)).to.deep.equal([second.address]);
        await expect(first.vault.initialize(owner.address, await token.getAddress(), first.release, commission.address))
            .to.be.revertedWith("Vault already initialized");
        const implementation = await ethers.getContractAt("BALTGiftVaultUSD18", await factory.giftVaultImplementation());
        await expect(implementation.initialize(owner.address, await token.getAddress(), first.release, commission.address))
            .to.be.revertedWith("Vault already initialized");
    });

    it("rejects past or current release timestamps", async function () {
        const latest = await ethers.provider.getBlock("latest");
        await expect(factory.createGiftVault(latest.timestamp)).to.be.revertedWith("Invalid release timestamp");
        await expect(factory.createGiftVault(latest.timestamp - 1)).to.be.revertedWith("Invalid release timestamp");
    });

    it("rejects incorrect creator, beneficiary, value, amount and missing allowance", async function () {
        const { vault } = await createVault();
        await expect(vault.connect(outsider).registerGift(beneficiary.address, units("10")))
            .to.be.revertedWith("Only the creator can register the gift");
        await expect(vault.registerGift(ethers.ZeroAddress, units("10"))).to.be.revertedWith("Invalid beneficiary address");
        await expect(vault.registerGift(beneficiary.address, 0)).to.be.revertedWith("Must deposit funds for gift");
        await expect(vault.registerGift(beneficiary.address, units("1"), { value: 1n })).to.be.revertedWith("No RBTC top-up required");
        await expect(register(vault, units("0.999999999999999999"))).to.be.revertedWith("Deposit too small, minimum is 1 token");
        await expect(vault.registerGift(beneficiary.address, units("10"))).to.be.reverted;
        expect(await vault.beneficiary()).to.equal(ethers.ZeroAddress);
    });

    it("registers an exactly 1-token gift without commission or gas top-up", async function () {
        const { vault, release } = await createVault();
        const amount = units("1");
        const balanceBefore = await ethers.provider.getBalance(await vault.getAddress());
        await expect(register(vault, amount))
            .to.emit(vault, "GiftRegistered").withArgs(owner.address, beneficiary.address, amount, release)
            .and.to.emit(vault, "FeeApplied").withArgs(owner.address, 0, 0, 0, amount);
        expect(await token.balanceOf(await vault.getAddress())).to.equal(amount);
        expect(await token.balanceOf(commission.address)).to.equal(0);
        expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(balanceBefore);
        const details = await vault.getGiftDetails();
        expect(details[0]).to.equal(beneficiary.address);
        expect(details[1]).to.equal(amount);
        await expect(register(vault, amount)).to.be.revertedWith("Gift already registered");
    });

    it("has a free tier inclusive of 200 tokens", async function () {
        const { vault } = await createVault();
        await register(vault, units("200"));
        expect(await vault.giftAmount()).to.equal(units("200"));
        expect(await token.balanceOf(commission.address)).to.equal(0);
    });

    it("applies 20 bps above 200 tokens and sends fee to the commission wallet", async function () {
        const { vault } = await createVault();
        await expect(register(vault, units("1000")))
            .to.emit(vault, "FeeApplied").withArgs(owner.address, 20, units("50"), units("2"), units("1000"));
        expect(await vault.giftAmount()).to.equal(units("998"));
        expect(await token.balanceOf(await vault.getAddress())).to.equal(units("998"));
        expect(await token.balanceOf(commission.address)).to.equal(units("2"));
    });

    it("caps the commission at 50 tokens", async function () {
        const { vault } = await createVault();
        await expect(register(vault, units("30000")))
            .to.emit(vault, "FeeApplied").withArgs(owner.address, 20, units("50"), units("50"), units("30000"));
        expect(await vault.giftAmount()).to.equal(units("29950"));
        expect(await token.balanceOf(commission.address)).to.equal(units("50"));
    });

    it("allows only the creator to cancel before release and refunds the locked tokens", async function () {
        const { vault } = await createVault();
        await register(vault, units("1000"));
        await expect(vault.connect(outsider).cancelGift()).to.be.revertedWith("Only creator can cancel");
        await expect(vault.cancelGift()).to.emit(vault, "GiftCancelled").withArgs(owner.address, units("998"));
        expect(await token.balanceOf(await vault.getAddress())).to.equal(0);
        expect(await vault.giftStatus()).to.equal(2);
        expect(await token.balanceOf(commission.address)).to.equal(units("2"));
        await expect(vault.cancelGift()).to.be.revertedWith("Gift is not active");
    });

    it("releases only to the beneficiary after the deadline, once", async function () {
        const { vault, release } = await createVault();
        await register(vault, units("10"));
        await expect(vault.connect(beneficiary).claimGift()).to.be.revertedWith("Gift is not claimable yet");
        await advanceTo(release);
        await expect(vault.cancelGift()).to.be.revertedWith("Gift is already claimable");
        await expect(vault.connect(outsider).claimGift()).to.be.revertedWith("Only the beneficiary can claim the gift");
        await expect(vault.connect(beneficiary).claimGift())
            .to.emit(vault, "GiftReleased").withArgs(beneficiary.address, units("10"));
        expect(await token.balanceOf(beneficiary.address)).to.equal(units("10"));
        expect(await token.balanceOf(await vault.getAddress())).to.equal(0);
        expect(await vault.giftStatus()).to.equal(1);
        await expect(vault.connect(beneficiary).claimGift()).to.be.revertedWith("Gift is not active");
    });

    it("does not permit registration after the configured date", async function () {
        const { vault, release } = await createVault();
        await advanceTo(release);
        await expect(register(vault, units("10"))).to.be.revertedWith("Release timestamp has already passed");
    });

    it("rejects fee-on-transfer tokens without persisting a partial registration", async function () {
        const feeToken = await ethers.deployContract("MockGiftTokenFeeOnTransfer");
        await feeToken.waitForDeployment();
        await feeToken.mint(owner.address, units("100"));
        const feeFactory = await ethers.deployContract("BALTGiftFactoryUSD18", [commission.address, await feeToken.getAddress()]);
        await feeFactory.waitForDeployment();
        const release = (await ethers.provider.getBlock("latest")).timestamp + 3600;
        const tx = await feeFactory.createGiftVault(release);
        const receipt = await tx.wait();
        const event = receipt.logs.map((log) => { try { return feeFactory.interface.parseLog(log); } catch { return null; } })
            .find((log) => log?.name === "GiftVaultCreated");
        const vault = await ethers.getContractAt("BALTGiftVaultUSD18", event.args.vaultAddress);
        await feeToken.approve(await vault.getAddress(), units("10"));
        await expect(vault.registerGift(beneficiary.address, units("10"))).to.be.revertedWith("Invalid received amount");
        expect(await vault.beneficiary()).to.equal(ethers.ZeroAddress);
        expect(await feeToken.balanceOf(await vault.getAddress())).to.equal(0);
    });

    it("supports non-standard tokens with no return values on transfers", async function () {
        const noReturnToken = await ethers.deployContract("MockGiftTokenNoReturn");
        await noReturnToken.waitForDeployment();
        await noReturnToken.mint(owner.address, units("500"));
        const noReturnFactory = await ethers.deployContract("BALTGiftFactoryUSD18", [commission.address, await noReturnToken.getAddress()]);
        await noReturnFactory.waitForDeployment();
        const release = (await ethers.provider.getBlock("latest")).timestamp + 3600;
        const creation = await noReturnFactory.createGiftVault(release);
        const receipt = await creation.wait();
        const created = receipt.logs.map((log) => { try { return noReturnFactory.interface.parseLog(log); } catch { return null; } })
            .find((log) => log?.name === "GiftVaultCreated");
        const vault = await ethers.getContractAt("BALTGiftVaultUSD18", created.args.vaultAddress);
        await noReturnToken.approve(await vault.getAddress(), units("300"));
        await vault.registerGift(beneficiary.address, units("300"));
        expect(await vault.giftAmount()).to.equal(units("299.4"));
        expect(await noReturnToken.balanceOf(commission.address)).to.equal(units("0.6"));
        await advanceTo(release);
        await vault.connect(beneficiary).claimGift();
        expect(await noReturnToken.balanceOf(beneficiary.address)).to.equal(units("299.4"));
    });

});
