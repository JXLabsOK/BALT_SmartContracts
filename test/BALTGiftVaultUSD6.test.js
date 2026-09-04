const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

const parseUnits = ethers.parseUnits;

describe("BALTGiftVaultUSD6", function () {
    let deployer, creator, beneficiary, commissionWallet, other;
    let token, factory, vault;

    const initialSupply = parseUnits("1000000", 6);
    const creatorBalance = parseUnits("200000", 6);
    const releaseDelay = 60 * 60 * 24 * 30;
    const gasTopUp = ethers.parseEther("0.0002");

    async function getFutureReleaseTimestamp() {
        const block = await ethers.provider.getBlock("latest");
        return block.timestamp + releaseDelay;
    }

    async function createVault() {
        const releaseTimestamp = await getFutureReleaseTimestamp();
        const tx = await factory.connect(creator).createGiftVault(releaseTimestamp);
        const receipt = await tx.wait();
        const event = receipt.logs.find((log) => log.fragment && log.fragment.name === "GiftVaultCreated");
        const Vault = await ethers.getContractFactory("BALTGiftVaultUSD6");

        return {
            releaseTimestamp,
            vault: Vault.attach(event.args.vaultAddress),
        };
    }

    async function registerGift(amount, selectedBeneficiary = beneficiary) {
        await (await token.connect(creator).approve(vault.target, amount)).wait();

        return vault.connect(creator).registerGift(selectedBeneficiary.address, amount, {
            value: gasTopUp,
        });
    }

    async function increaseTimeTo(timestamp) {
        const block = await ethers.provider.getBlock("latest");
        const seconds = Number(BigInt(timestamp) - BigInt(block.timestamp));

        if (seconds > 0) {
            await hre.network.provider.send("evm_increaseTime", [seconds]);
        }

        await hre.network.provider.send("evm_mine");
    }

    beforeEach(async () => {
        [deployer, creator, beneficiary, commissionWallet, other] = await ethers.getSigners();

        const MockUSD6 = await ethers.getContractFactory("MockERC20USD6");
        token = await MockUSD6.connect(deployer).deploy("Mock USDT", "mUSDT", initialSupply);
        await token.waitForDeployment();

        await (await token.connect(deployer).transfer(creator.address, creatorBalance)).wait();

        const Factory = await ethers.getContractFactory("BALTGiftFactoryUSD6");
        factory = await Factory.connect(deployer).deploy(commissionWallet.address, token.target);
        await factory.waitForDeployment();

        const created = await createVault();
        vault = created.vault;
    });

    it("should initialize the clone with the expected values", async function () {
        expect(await vault.creator()).to.equal(creator.address);
        expect(await vault.giftToken()).to.equal(token.target);
        expect(await vault.commissionWallet()).to.equal(commissionWallet.address);
        expect(await vault.beneficiary()).to.equal(ethers.ZeroAddress);
        expect(await vault.giftStatus()).to.equal(0);
        expect(await vault.BENEFICIARY_GAS_TOPUP_WEI()).to.equal(gasTopUp);
    });

    it("should register a 1 USDT gift without fee", async function () {
        const amount = parseUnits("1", 6);

        await expect(registerGift(amount))
            .to.emit(vault, "GiftRegistered")
            .withArgs(creator.address, beneficiary.address, amount, await vault.releaseTimestamp());

        expect(await vault.giftAmount()).to.equal(amount);
        expect(await token.balanceOf(vault.target)).to.equal(amount);
        expect(await token.balanceOf(commissionWallet.address)).to.equal(0);
    });

    it("should not charge a fee up to and including 200 USDT", async function () {
        const amount = parseUnits("200", 6);

        await registerGift(amount);

        expect(await vault.giftAmount()).to.equal(amount);
        expect(await token.balanceOf(vault.target)).to.equal(amount);
        expect(await token.balanceOf(commissionWallet.address)).to.equal(0);
    });

    it("should charge 0.20% above 200 USDT", async function () {
        const amount = parseUnits("1000", 6);
        const fee = parseUnits("2", 6);
        const net = parseUnits("998", 6);

        await expect(registerGift(amount))
            .to.emit(vault, "FeeApplied")
            .withArgs(creator.address, 20, parseUnits("50", 6), fee, amount);

        expect(await vault.giftAmount()).to.equal(net);
        expect(await token.balanceOf(vault.target)).to.equal(net);
        expect(await token.balanceOf(commissionWallet.address)).to.equal(fee);
    });

    it("should cap the fee at 50 USDT", async function () {
        const amount = parseUnits("100000", 6);
        const fee = parseUnits("50", 6);
        const net = amount - fee;

        await registerGift(amount);

        expect(await vault.giftAmount()).to.equal(net);
        expect(await token.balanceOf(vault.target)).to.equal(net);
        expect(await token.balanceOf(commissionWallet.address)).to.equal(fee);
    });

    it("should send the fixed ETH gas top-up to the beneficiary", async function () {
        const amount = parseUnits("100", 6);
        const balanceBefore = await ethers.provider.getBalance(beneficiary.address);

        await expect(registerGift(amount))
            .to.emit(vault, "BeneficiaryGasTopUpSent")
            .withArgs(beneficiary.address, gasTopUp);

        const balanceAfter = await ethers.provider.getBalance(beneficiary.address);

        expect(balanceAfter - balanceBefore).to.equal(gasTopUp);
        expect(await ethers.provider.getBalance(vault.target)).to.equal(0);
    });

    it("should revert when the ETH gas top-up is missing", async function () {
        const amount = parseUnits("100", 6);

        await (await token.connect(creator).approve(vault.target, amount)).wait();

        await expect(
            vault.connect(creator).registerGift(beneficiary.address, amount, { value: 0 })
        ).to.be.revertedWith("Incorrect gas top-up");
    });

    it("should revert when the ETH gas top-up is greater than the fixed amount", async function () {
        const amount = parseUnits("100", 6);

        await (await token.connect(creator).approve(vault.target, amount)).wait();

        await expect(
            vault.connect(creator).registerGift(beneficiary.address, amount, {
                value: gasTopUp + 1n,
            })
        ).to.be.revertedWith("Incorrect gas top-up");
    });

    it("should revert if the net gift is below 1 USDT", async function () {
        const amount = parseUnits("0.999999", 6);

        await (await token.connect(creator).approve(vault.target, amount)).wait();

        await expect(
            vault.connect(creator).registerGift(beneficiary.address, amount, {
                value: gasTopUp,
            })
        ).to.be.revertedWith("Deposit too small, minimum is 1 USDT");
    });

    it("should revert if a non-creator tries to register the gift", async function () {
        const amount = parseUnits("100", 6);

        await expect(
            vault.connect(other).registerGift(beneficiary.address, amount, {
                value: gasTopUp,
            })
        ).to.be.revertedWith("Only the creator can register the gift");
    });

    it("should revert if the beneficiary is the zero address", async function () {
        const amount = parseUnits("100", 6);

        await (await token.connect(creator).approve(vault.target, amount)).wait();

        await expect(
            vault.connect(creator).registerGift(ethers.ZeroAddress, amount, {
                value: gasTopUp,
            })
        ).to.be.revertedWith("Invalid beneficiary address");
    });

    it("should revert if the gift is registered twice", async function () {
        const amount = parseUnits("100", 6);

        await registerGift(amount);
        await (await token.connect(creator).approve(vault.target, amount)).wait();

        await expect(
            vault.connect(creator).registerGift(other.address, amount, {
                value: gasTopUp,
            })
        ).to.be.revertedWith("Gift already registered");
    });

    it("should revert if token allowance is insufficient", async function () {
        const amount = parseUnits("100", 6);

        await expect(
            vault.connect(creator).registerGift(beneficiary.address, amount, {
                value: gasTopUp,
            })
        ).to.be.revertedWith("USD6: transferFrom failed");
    });

    it("should allow the creator to cancel before the release timestamp", async function () {
        const amount = parseUnits("1000", 6);
        const fee = parseUnits("2", 6);
        const refund = amount - fee;

        await registerGift(amount);

        const creatorBefore = await token.balanceOf(creator.address);

        await expect(vault.connect(creator).cancelGift())
            .to.emit(vault, "GiftCancelled")
            .withArgs(creator.address, refund);

        const creatorAfter = await token.balanceOf(creator.address);

        expect(creatorAfter - creatorBefore).to.equal(refund);
        expect(await token.balanceOf(vault.target)).to.equal(0);
        expect(await token.balanceOf(commissionWallet.address)).to.equal(fee);
        expect(await vault.giftStatus()).to.equal(2);
    });

    it("should include additional USDT sent to the vault in a cancellation", async function () {
        const amount = parseUnits("100", 6);
        const extra = parseUnits("25", 6);

        await registerGift(amount);
        await (await token.connect(creator).transfer(vault.target, extra)).wait();

        const creatorBefore = await token.balanceOf(creator.address);

        await vault.connect(creator).cancelGift();

        const creatorAfter = await token.balanceOf(creator.address);

        expect(creatorAfter - creatorBefore).to.equal(amount + extra);
        expect(await token.balanceOf(vault.target)).to.equal(0);
    });

    it("should not allow cancellation by a non-creator", async function () {
        await registerGift(parseUnits("100", 6));

        await expect(vault.connect(other).cancelGift()).to.be.revertedWith("Only creator can cancel");
    });

    it("should not allow cancellation once the gift is claimable", async function () {
        await registerGift(parseUnits("100", 6));

        await increaseTimeTo(await vault.releaseTimestamp());

        await expect(vault.connect(creator).cancelGift()).to.be.revertedWith("Gift is already claimable");
    });

    it("should allow the beneficiary to claim after the release timestamp", async function () {
        const amount = parseUnits("1000", 6);
        const fee = parseUnits("2", 6);
        const expectedClaim = amount - fee;

        await registerGift(amount);
        await increaseTimeTo(await vault.releaseTimestamp());

        const beneficiaryBefore = await token.balanceOf(beneficiary.address);

        await expect(vault.connect(beneficiary).claimGift())
            .to.emit(vault, "GiftReleased")
            .withArgs(beneficiary.address, expectedClaim);

        const beneficiaryAfter = await token.balanceOf(beneficiary.address);

        expect(beneficiaryAfter - beneficiaryBefore).to.equal(expectedClaim);
        expect(await token.balanceOf(vault.target)).to.equal(0);
        expect(await vault.giftStatus()).to.equal(1);
    });

    it("should include additional USDT sent to the vault in the beneficiary claim", async function () {
        const amount = parseUnits("100", 6);
        const extra = parseUnits("25", 6);

        await registerGift(amount);
        await (await token.connect(creator).transfer(vault.target, extra)).wait();
        await increaseTimeTo(await vault.releaseTimestamp());

        const beneficiaryBefore = await token.balanceOf(beneficiary.address);

        await vault.connect(beneficiary).claimGift();

        const beneficiaryAfter = await token.balanceOf(beneficiary.address);

        expect(beneficiaryAfter - beneficiaryBefore).to.equal(amount + extra);
        expect(await token.balanceOf(vault.target)).to.equal(0);
    });

    it("should not allow a claim before the release timestamp", async function () {
        await registerGift(parseUnits("100", 6));

        await expect(vault.connect(beneficiary).claimGift()).to.be.revertedWith("Gift is not claimable yet");
    });

    it("should not allow a non-beneficiary to claim", async function () {
        await registerGift(parseUnits("100", 6));
        await increaseTimeTo(await vault.releaseTimestamp());

        await expect(vault.connect(other).claimGift()).to.be.revertedWith("Only the beneficiary can claim the gift");
    });

    it("should not allow the gift to be claimed twice", async function () {
        await registerGift(parseUnits("100", 6));
        await increaseTimeTo(await vault.releaseTimestamp());

        await vault.connect(beneficiary).claimGift();

        await expect(vault.connect(beneficiary).claimGift()).to.be.revertedWith("Gift is not active");
    });

    it("should return the expected gift details", async function () {
        const amount = parseUnits("1000", 6);
        const expectedGiftAmount = parseUnits("998", 6);

        await registerGift(amount);

        const details = await vault.getGiftDetails();

        expect(details[0]).to.equal(beneficiary.address);
        expect(details[1]).to.equal(expectedGiftAmount);
        expect(details[2]).to.equal(await vault.releaseTimestamp());
        expect(details[3]).to.equal(await vault.createdAt());
        expect(details[4]).to.equal(0);
    });
});
