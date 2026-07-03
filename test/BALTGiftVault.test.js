const { expect } = require("chai");
const hre = require("hardhat");

const ethers = hre.ethers;
const parseEther = ethers.parseEther;
const toWei = (s) => ethers.parseEther(s);

describe("BALTGiftVault via Factory", function () {
  let creator, beneficiary, other, commissionWallet;
  let factory, vault;
  let releaseTimestamp;
  let depositAmount;

  const releaseDelay = 60 * 60 * 24 * 30;

  async function getFutureReleaseTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp + releaseDelay;
  }

  async function moveToReleaseDate(timestamp) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp + 1]);
    await ethers.provider.send("evm_mine");
  }

  async function deployFreshGiftVault(customReleaseTimestamp) {
    const selectedReleaseTimestamp =
      customReleaseTimestamp || await getFutureReleaseTimestamp();

    const tx = await factory
      .connect(creator)
      .createGiftVault(selectedReleaseTimestamp);

    await tx.wait();

    const vaultAddresses = await factory.getGiftVaultsByCreator(creator.address);
    const vaultAddress = vaultAddresses[vaultAddresses.length - 1];

    const Vault = await ethers.getContractFactory("BALTGiftVault");
    const freshVault = await Vault.attach(vaultAddress);

    return { freshVault, selectedReleaseTimestamp, vaultAddress };
  }

  beforeEach(async () => {
    [creator, beneficiary, other, commissionWallet] = await ethers.getSigners();

    depositAmount = parseEther("1");
    releaseTimestamp = await getFutureReleaseTimestamp();

    const Factory = await ethers.getContractFactory("BALTGiftFactory");
    factory = await Factory.deploy(commissionWallet.address);
    await factory.waitForDeployment();

    const deployed = await deployFreshGiftVault(releaseTimestamp);
    vault = deployed.freshVault;

    await vault
      .connect(creator)
      .registerGift(beneficiary.address, { value: depositAmount });
  });

  it("should store the correct creator and release timestamp", async function () {
    expect(await vault.creator()).to.equal(creator.address);
    expect(await vault.releaseTimestamp()).to.equal(BigInt(releaseTimestamp));
  });

  it("should store the correct commission wallet", async function () {
    expect(await vault.commissionWallet()).to.equal(commissionWallet.address);
  });

  it("should store createdAt and active status after clone initialization", async function () {
    expect(await vault.createdAt()).to.be.gt(0);
    expect(await vault.giftStatus()).to.equal(0);
  });

  it("should prevent reinitializing a cloned Gift Vault", async function () {
    const deployed = await deployFreshGiftVault();
    const freshVault = deployed.freshVault;
    const nextReleaseTimestamp = await getFutureReleaseTimestamp();

    await expect(
      freshVault.initialize(
        creator.address,
        nextReleaseTimestamp,
        commissionWallet.address
      )
    ).to.be.revertedWith("Vault already initialized");
  });

  it("should store the correct beneficiary and gift amount", async function () {
    const details = await vault.getGiftDetails();

    expect(details[0]).to.equal(beneficiary.address);
    expect(details[1]).to.equal(await vault.giftAmount());
    expect(details[2]).to.equal(BigInt(releaseTimestamp));
  });

  it("should revert claimGift if called before release timestamp", async function () {
    await expect(
      vault.connect(beneficiary).claimGift()
    ).to.be.revertedWith("Gift is not claimable yet");
  });

  it("should allow claimGift after release timestamp", async function () {
    await moveToReleaseDate(releaseTimestamp);

    await expect(
      vault.connect(beneficiary).claimGift()
    ).to.not.be.reverted;
  });

  it("should prevent non-beneficiary from claiming", async function () {
    await moveToReleaseDate(releaseTimestamp);

    await expect(
      vault.connect(other).claimGift()
    ).to.be.revertedWith("Only the beneficiary can claim the gift");
  });

  it("should prevent double claim", async function () {
    await moveToReleaseDate(releaseTimestamp);

    await vault.connect(beneficiary).claimGift();

    await expect(
      vault.connect(beneficiary).claimGift()
    ).to.be.revertedWith("Gift is not active");
  });

  it("should allow the creator to cancel before release timestamp", async function () {
    await expect(
      vault.connect(creator).cancelGift()
    ).to.not.be.reverted;
  });

  it("should emit correct event on cancel", async function () {
    const refundAmount = await ethers.provider.getBalance(vault.target);

    await expect(
      vault.connect(creator).cancelGift()
    ).to.emit(vault, "GiftCancelled")
      .withArgs(creator.address, refundAmount);
  });

  it("should prevent non-creator from canceling", async function () {
    await expect(
      vault.connect(beneficiary).cancelGift()
    ).to.be.revertedWith("Only creator can cancel");
  });

  it("should prevent creator from canceling after release timestamp", async function () {
    await moveToReleaseDate(releaseTimestamp);

    await expect(
      vault.connect(creator).cancelGift()
    ).to.be.revertedWith("Gift is already claimable");
  });

  it("should revert claim after cancel", async function () {
    await vault.connect(creator).cancelGift();

    await moveToReleaseDate(releaseTimestamp);

    await expect(
      vault.connect(beneficiary).claimGift()
    ).to.be.revertedWith("Gift is not active");
  });

  it("should emit correct event on claim", async function () {
    await moveToReleaseDate(releaseTimestamp);

    const amount = await vault.giftAmount();

    await expect(
      vault.connect(beneficiary).claimGift()
    ).to.emit(vault, "GiftReleased")
      .withArgs(beneficiary.address, amount);
  });

  it("should prevent registering a gift twice", async function () {
    await expect(
      vault.connect(creator).registerGift(beneficiary.address, {
        value: depositAmount,
      })
    ).to.be.revertedWith("Gift already registered");
  });

  it("should prevent non-creator from registering the gift", async function () {
    const deployed = await deployFreshGiftVault();
    const freshVault = deployed.freshVault;

    await expect(
      freshVault.connect(other).registerGift(beneficiary.address, {
        value: depositAmount,
      })
    ).to.be.revertedWith("Only the creator can register the gift");
  });

  // BΔLT-GIFT-003
  it("should revert if deposit is below minimum 1000 satoshis", async function () {
    const deployed = await deployFreshGiftVault();
    const freshVault = deployed.freshVault;

    const tinyDeposit = ethers.parseUnits("0.000009", "ether"); // 900 satoshis

    await expect(
      freshVault.connect(creator).registerGift(beneficiary.address, {
        value: tinyDeposit,
      })
    ).to.be.revertedWith("Deposit too small, minimum is 1000 satoshis");
  });

  it("should allow deposit equal to minimum 1000 satoshis", async function () {
    const deployed = await deployFreshGiftVault();
    const freshVault = deployed.freshVault;

    const minimumDeposit = ethers.parseUnits("0.00001", "ether"); // 1000 satoshis

    await expect(
      freshVault.connect(creator).registerGift(beneficiary.address, {
        value: minimumDeposit,
      })
    ).to.not.be.reverted;

    expect(await freshVault.giftAmount()).to.equal(minimumDeposit);
  });
  // BΔLT-GIFT-003 END

  // BΔLT-GIFT-006
  it("should revert if beneficiary is the zero address", async function () {
    const deployed = await deployFreshGiftVault();
    const freshVault = deployed.freshVault;

    await expect(
      freshVault.connect(creator).registerGift(ethers.ZeroAddress, {
        value: depositAmount,
      })
    ).to.be.revertedWith("Invalid beneficiary address");
  });
  // BΔLT-GIFT-006 END

  describe("Fees & Caps standalone", function () {
    const FREE_TIER_MAX = toWei("0.01");
    const GIFT_FEE_CAP = toWei("0.05");

    async function newGiftVaultWithCommission(selectedCommissionWallet) {
      const Factory = await ethers.getContractFactory("BALTGiftFactory");
      const f = await Factory.deploy(selectedCommissionWallet);
      await f.waitForDeployment();

      const block = await ethers.provider.getBlock("latest");
      const selectedReleaseTimestamp = block.timestamp + releaseDelay;

      await f.connect(creator).createGiftVault(selectedReleaseTimestamp);

      const addrs = await f.getGiftVaultsByCreator(creator.address);
      const vAddr = addrs[addrs.length - 1];

      const Vault = await ethers.getContractFactory("BALTGiftVault");
      const v = await Vault.attach(vAddr);

      return { f, v, selectedReleaseTimestamp };
    }

    it("fee free-tier: <= 0.01 BTC charges 0 and bps/cap = 0", async function () {
      const { v } = await newGiftVaultWithCommission(other.address);

      const dep = FREE_TIER_MAX;

      await expect(
        v.connect(creator).registerGift(beneficiary.address, { value: dep })
      ).to.emit(v, "FeeApplied")
        .withArgs(creator.address, 0, 0, 0, dep);

      expect(await v.giftAmount()).to.equal(dep);
    });

    it("fee above free-tier uses flat 0.2% fee", async function () {
      const { v } = await newGiftVaultWithCommission(other.address);

      const dep = toWei("0.02");
      const expectedFee = toWei("0.00004"); // 0.2% of 0.02 BTC

      await expect(
        v.connect(creator).registerGift(beneficiary.address, { value: dep })
      ).to.emit(v, "FeeApplied")
        .withArgs(creator.address, 20, GIFT_FEE_CAP, expectedFee, dep);

      expect(await v.giftAmount()).to.equal(dep - expectedFee);
    });

    it("fee 0.2% for 1 BTC without cap fee = 0.002", async function () {
      const { v } = await newGiftVaultWithCommission(other.address);

      const dep = toWei("1");
      const expectedFee = toWei("0.002"); // 0.2% of 1 BTC

      await expect(
        v.connect(creator).registerGift(beneficiary.address, { value: dep })
      ).to.emit(v, "FeeApplied")
        .withArgs(creator.address, 20, GIFT_FEE_CAP, expectedFee, dep);

      expect(await v.giftAmount()).to.equal(dep - expectedFee);
    });

    it("fee 0.2% for 10 BTC without cap fee = 0.02", async function () {
      const { v } = await newGiftVaultWithCommission(other.address);

      const dep = toWei("10");
      const expectedFee = toWei("0.02"); // 0.2% of 10 BTC

      await expect(
        v.connect(creator).registerGift(beneficiary.address, { value: dep })
      ).to.emit(v, "FeeApplied")
        .withArgs(creator.address, 20, GIFT_FEE_CAP, expectedFee, dep);

      expect(await v.giftAmount()).to.equal(dep - expectedFee);
    });

    it("cap starts at 25 BTC: raw fee = 0.05 and fee = 0.05", async function () {
      const { v } = await newGiftVaultWithCommission(other.address);

      const dep = toWei("25");
      const expectedFee = toWei("0.05"); // 0.2% of 25 BTC

      await expect(
        v.connect(creator).registerGift(beneficiary.address, { value: dep })
      ).to.emit(v, "FeeApplied")
        .withArgs(creator.address, 20, GIFT_FEE_CAP, expectedFee, dep);

      expect(await v.giftAmount()).to.equal(dep - expectedFee);
    });

    it("cap applies above 25 BTC: 50 BTC raw fee = 0.10 but fee = 0.05", async function () {
      const { v } = await newGiftVaultWithCommission(other.address);

      const dep = toWei("50");
      const expectedFee = toWei("0.05"); // capped fee

      await expect(
        v.connect(creator).registerGift(beneficiary.address, { value: dep })
      ).to.emit(v, "FeeApplied")
        .withArgs(creator.address, 20, GIFT_FEE_CAP, expectedFee, dep);

      expect(await v.giftAmount()).to.equal(dep - expectedFee);
    });

    it("cap applies for very large gifts: 100 BTC fee = 0.05", async function () {
      const { v } = await newGiftVaultWithCommission(other.address);

      const dep = toWei("100");
      const expectedFee = toWei("0.05"); // capped fee

      await expect(
        v.connect(creator).registerGift(beneficiary.address, { value: dep })
      ).to.emit(v, "FeeApplied")
        .withArgs(creator.address, 20, GIFT_FEE_CAP, expectedFee, dep);

      expect(await v.giftAmount()).to.equal(dep - expectedFee);
    });

    it("transfers the commission to the commission wallet", async function () {
      const { v } = await newGiftVaultWithCommission(other.address);

      const dep = toWei("10");
      const expectedFee = toWei("0.02"); // 0.2% of 10 BTC

      const before = await ethers.provider.getBalance(other.address);

      await v.connect(creator).registerGift(beneficiary.address, {
        value: dep,
      });

      const after = await ethers.provider.getBalance(other.address);

      expect(after - before).to.equal(expectedFee);
      expect(await v.giftAmount()).to.equal(dep - expectedFee);
    });

    it("should prevent registering a gift after release timestamp has passed", async function () {
      const block = await ethers.provider.getBlock("latest");
      const shortReleaseTimestamp = block.timestamp + 60;

      const deployed = await deployFreshGiftVault(shortReleaseTimestamp);
      const freshVault = deployed.freshVault;

      await moveToReleaseDate(shortReleaseTimestamp);

      await expect(
        freshVault.connect(creator).registerGift(beneficiary.address, {
          value: depositAmount,
        })
      ).to.be.revertedWith("Release timestamp has already passed");
    });
  });
});