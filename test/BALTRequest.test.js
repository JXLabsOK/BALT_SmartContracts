const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("BALTRequest", function () {
    const ZERO_ADDRESS = ethers.ZeroAddress;

    const REQUEST_FEE_BPS = 50n;
    const BPS_DENOM = 10_000n;
    const MAX_BATCH_SIZE = 10n;
    const MAX_DESCRIPTION_LENGTH = 160n;

    let deployer;
    let merchant;
    let payer;
    let payer2;
    let commissionWallet;
    let other;

    let token6;
    let token18;

    let nativeRequest;
    let tokenRequest;

    async function deployRequest(commission, asset) {
        const BALTRequest = await ethers.getContractFactory("BALTRequest");
        const contract = await BALTRequest.deploy(commission, asset);
        await contract.waitForDeployment();
        return contract;
    }

    async function createRequests(contract, signer, amount, expiresAt = 0, quantity = 1, description = "Test payment") {
        const result = await contract.connect(signer).createRequests.staticCall(
            amount,
            expiresAt,
            quantity,
            description
        );

        const batchId = result[0];
        const firstRequestId = result[1];

        const tx = await contract.connect(signer).createRequests(
            amount,
            expiresAt,
            quantity,
            description
        );

        await tx.wait();

        return {
            batchId,
            firstRequestId,
            tx
        };
    }

    beforeEach(async function () {
        [deployer, merchant, payer, payer2, commissionWallet, other] = await ethers.getSigners();

        const MockRequestERC20 = await ethers.getContractFactory("MockRequestERC20");

        token6 = await MockRequestERC20.deploy("Mock USD6", "MUSD6", 6);
        await token6.waitForDeployment();

        token18 = await MockRequestERC20.deploy("Mock USD18", "MUSD18", 18);
        await token18.waitForDeployment();

        await token6.mint(payer.address, ethers.parseUnits("100000", 6));
        await token6.mint(payer2.address, ethers.parseUnits("100000", 6));

        await token18.mint(payer.address, ethers.parseUnits("100000", 18));

        nativeRequest = await deployRequest(commissionWallet.address, ZERO_ADDRESS);
        tokenRequest = await deployRequest(commissionWallet.address, await token6.getAddress());
    });

    describe("Deployment", function () {
        it("Should configure native asset deployment correctly", async function () {
            expect(await nativeRequest.commissionWallet()).to.equal(commissionWallet.address);
            expect(await nativeRequest.requestAsset()).to.equal(ZERO_ADDRESS);
            expect(await nativeRequest.REQUEST_FEE_BPS()).to.equal(REQUEST_FEE_BPS);
            expect(await nativeRequest.BPS_DENOM()).to.equal(BPS_DENOM);
            expect(await nativeRequest.MAX_BATCH_SIZE()).to.equal(MAX_BATCH_SIZE);
            expect(await nativeRequest.MAX_DESCRIPTION_LENGTH()).to.equal(MAX_DESCRIPTION_LENGTH);
        });

        it("Should configure ERC20 deployment correctly", async function () {
            expect(await tokenRequest.commissionWallet()).to.equal(commissionWallet.address);
            expect(await tokenRequest.requestAsset()).to.equal(await token6.getAddress());
        });

        it("Should initialize counters correctly", async function () {
            expect(await nativeRequest.nextBatchId()).to.equal(1n);
            expect(await nativeRequest.nextRequestId()).to.equal(1n);
            expect(await nativeRequest.totalBatches()).to.equal(0n);
            expect(await nativeRequest.totalRequests()).to.equal(0n);
        });

        it("Should reject zero commission wallet", async function () {
            const BALTRequest = await ethers.getContractFactory("BALTRequest");

            await expect(
                BALTRequest.deploy(ZERO_ADDRESS, ZERO_ADDRESS)
            ).to.be.revertedWith("Invalid commission wallet");
        });

        it("Should reject an EOA as ERC20 asset", async function () {
            const BALTRequest = await ethers.getContractFactory("BALTRequest");

            await expect(
                BALTRequest.deploy(commissionWallet.address, other.address)
            ).to.be.revertedWith("Request asset must be contract");
        });

        it("Should reject direct native transfers", async function () {
            await expect(
                payer.sendTransaction({
                    to: await nativeRequest.getAddress(),
                    value: ethers.parseEther("1")
                })
            ).to.be.revertedWith("Direct payments not accepted");
        });
    });

    describe("Request creation", function () {
        it("Should create one request", async function () {
            const amount = ethers.parseEther("1");

            const { batchId, firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                1,
                "Bitcoin Whitepaper Puzzle"
            );

            expect(batchId).to.equal(1n);
            expect(firstRequestId).to.equal(1n);

            const batch = await nativeRequest.getBatch(batchId);

            expect(batch.merchant).to.equal(merchant.address);
            expect(batch.amount).to.equal(amount);
            expect(batch.firstRequestId).to.equal(1n);
            expect(batch.expiresAt).to.equal(0n);
            expect(batch.quantity).to.equal(1n);
            expect(batch.description).to.equal("Bitcoin Whitepaper Puzzle");

            const result = await nativeRequest.getRequest(firstRequestId);
            const paymentRequest = result[0];

            expect(paymentRequest.batchId).to.equal(batchId);
            expect(paymentRequest.payer).to.equal(ZERO_ADDRESS);
            expect(paymentRequest.paidAt).to.equal(0n);
            expect(paymentRequest.status).to.equal(0n);
        });

        it("Should create ten requests in one batch", async function () {
            const amount = ethers.parseEther("0.01");

            const { batchId, firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                10,
                "Batch of ten"
            );

            expect(firstRequestId).to.equal(1n);
            expect(await nativeRequest.totalBatches()).to.equal(1n);
            expect(await nativeRequest.totalRequests()).to.equal(10n);
            expect(await nativeRequest.nextRequestId()).to.equal(11n);

            for (let i = 0n; i < 10n; i++) {
                const result = await nativeRequest.getRequest(firstRequestId + i);
                expect(result[0].batchId).to.equal(batchId);
                expect(result[0].status).to.equal(0n);
            }
        });

        it("Should support every valid batch size from 1 to 10", async function () {
            let expectedRequests = 0n;

            for (let quantity = 1; quantity <= 10; quantity++) {
                await createRequests(
                    nativeRequest,
                    merchant,
                    ethers.parseEther("0.01"),
                    0,
                    quantity,
                    `Batch ${quantity}`
                );

                expectedRequests += BigInt(quantity);
            }

            expect(await nativeRequest.totalBatches()).to.equal(10n);
            expect(await nativeRequest.totalRequests()).to.equal(expectedRequests);
        });

        it("Should reject quantity zero", async function () {
            await expect(
                nativeRequest.connect(merchant).createRequests(
                    ethers.parseEther("1"),
                    0,
                    0,
                    "Invalid batch"
                )
            ).to.be.revertedWith("Invalid quantity");
        });

        it("Should reject more than ten requests", async function () {
            await expect(
                nativeRequest.connect(merchant).createRequests(
                    ethers.parseEther("1"),
                    0,
                    11,
                    "Invalid batch"
                )
            ).to.be.revertedWith("Invalid quantity");
        });

        it("Should reject zero amount", async function () {
            await expect(
                nativeRequest.connect(merchant).createRequests(
                    0,
                    0,
                    1,
                    "Invalid amount"
                )
            ).to.be.revertedWith("Invalid amount");
        });

        it("Should allow no expiration", async function () {
            const { batchId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                1,
                "No expiration"
            );

            const batch = await nativeRequest.getBatch(batchId);
            expect(batch.expiresAt).to.equal(0n);
        });

        it("Should allow future expiration", async function () {
            const expiration = BigInt(await time.latest()) + 3600n;

            const { batchId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                expiration,
                1,
                "Future expiration"
            );

            const batch = await nativeRequest.getBatch(batchId);
            expect(batch.expiresAt).to.equal(expiration);
        });

        it("Should reject past expiration", async function () {
            const expiration = BigInt(await time.latest()) - 1n;

            await expect(
                nativeRequest.connect(merchant).createRequests(
                    ethers.parseEther("1"),
                    expiration,
                    1,
                    "Expired"
                )
            ).to.be.revertedWith("Invalid expiration");
        });

        it("Should accept empty description", async function () {
            const { batchId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                1,
                ""
            );

            const batch = await nativeRequest.getBatch(batchId);
            expect(batch.description).to.equal("");
        });

        it("Should accept exactly 160 ASCII bytes", async function () {
            const description = "A".repeat(160);

            const { batchId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                1,
                description
            );

            const batch = await nativeRequest.getBatch(batchId);
            expect(batch.description).to.equal(description);
        });

        it("Should reject more than 160 bytes", async function () {
            const description = "A".repeat(161);

            await expect(
                nativeRequest.connect(merchant).createRequests(
                    ethers.parseEther("1"),
                    0,
                    1,
                    description
                )
            ).to.be.revertedWith("Description too long");
        });

        it("Should measure description limit in UTF-8 bytes", async function () {
            const validDescription = "₿".repeat(53);
            const invalidDescription = "₿".repeat(54);

            await expect(
                nativeRequest.connect(merchant).createRequests(
                    ethers.parseEther("1"),
                    0,
                    1,
                    validDescription
                )
            ).to.not.be.reverted;

            await expect(
                nativeRequest.connect(merchant).createRequests(
                    ethers.parseEther("1"),
                    0,
                    1,
                    invalidDescription
                )
            ).to.be.revertedWith("Description too long");
        });

        it("Should increment batch and request IDs correctly", async function () {
            const first = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                3,
                "First"
            );

            const second = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("2"),
                0,
                4,
                "Second"
            );

            expect(first.batchId).to.equal(1n);
            expect(first.firstRequestId).to.equal(1n);

            expect(second.batchId).to.equal(2n);
            expect(second.firstRequestId).to.equal(11n);

            expect(await nativeRequest.nextBatchId()).to.equal(3n);
            expect(await nativeRequest.nextRequestId()).to.equal(21n);

            expect(await nativeRequest.totalBatches()).to.equal(2n);
            expect(await nativeRequest.totalRequests()).to.equal(7n);
        });

        it("Should keep merchant batches separated", async function () {
            await createRequests(nativeRequest, merchant, ethers.parseEther("1"), 0, 1, "Merchant 1");
            await createRequests(nativeRequest, other, ethers.parseEther("1"), 0, 1, "Merchant 2");
            await createRequests(nativeRequest, merchant, ethers.parseEther("1"), 0, 1, "Merchant 1 second");

            expect(await nativeRequest.batchIdsByMerchantCount(merchant.address)).to.equal(2n);
            expect(await nativeRequest.batchIdsByMerchantCount(other.address)).to.equal(1n);

            const merchantBatches = await nativeRequest.getBatchIdsByMerchantSlice(
                merchant.address,
                0,
                10
            );

            expect(merchantBatches).to.deep.equal([1n, 3n]);
        });

        it("Should emit RequestBatchCreated correctly", async function () {
            const amount = ethers.parseEther("1");
            const expiration = BigInt(await time.latest()) + 3600n;

            await expect(
                nativeRequest.connect(merchant).createRequests(
                    amount,
                    expiration,
                    5,
                    "Event test"
                )
            ).to.emit(nativeRequest, "RequestBatchCreated")
                .withArgs(
                    1n,
                    merchant.address,
                    1n,
                    amount,
                    5n,
                    expiration,
                    "Event test"
                );
        });
    });

    describe("Optimized request ID layout and storage bounds", function () {
        it("Should reserve ten request IDs per batch", async function () {
            const first = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                3,
                "First reserved range"
            );

            const second = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("2"),
                0,
                2,
                "Second reserved range"
            );

            const third = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("3"),
                0,
                1,
                "Third reserved range"
            );

            expect(first.batchId).to.equal(1n);
            expect(first.firstRequestId).to.equal(1n);

            expect(second.batchId).to.equal(2n);
            expect(second.firstRequestId).to.equal(11n);

            expect(third.batchId).to.equal(3n);
            expect(third.firstRequestId).to.equal(21n);

            expect(await nativeRequest.nextBatchId()).to.equal(4n);
            expect(await nativeRequest.nextRequestId()).to.equal(31n);
            expect(await nativeRequest.totalBatches()).to.equal(3n);
            expect(await nativeRequest.totalRequests()).to.equal(6n);
        });

        it("Should reject unused request IDs inside a reserved batch range", async function () {
            await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                3,
                "Three requests"
            );

            await expect(
                nativeRequest.getRequest(4)
            ).to.be.revertedWith("Request not found");

            await expect(
                nativeRequest.getRequest(10)
            ).to.be.revertedWith("Request not found");
        });

        it("Should reject request ID zero", async function () {
            await expect(
                nativeRequest.getRequest(0)
            ).to.be.revertedWith("Request not found");

            await expect(
                nativeRequest.isExpired(0)
            ).to.be.revertedWith("Request not found");

            await expect(
                nativeRequest.connect(merchant).cancelRequest(0)
            ).to.be.revertedWith("Request not found");

            await expect(
                nativeRequest.connect(payer).payRequest(0, {
                    value: ethers.parseEther("1")
                })
            ).to.be.revertedWith("Request not found");
        });

        it("Should accept the maximum uint128 amount", async function () {
            const maxUint128 = (1n << 128n) - 1n;

            const { batchId, firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                maxUint128,
                0,
                1,
                "Max uint128"
            );

            const batch = await nativeRequest.getBatch(batchId);
            const result = await nativeRequest.getRequest(firstRequestId);

            expect(batch.amount).to.equal(maxUint128);
            expect(result[0].batchId).to.equal(batchId);
            expect(result[0].status).to.equal(0n);
        });

        it("Should reject amounts greater than uint128", async function () {
            const tooLarge = 1n << 128n;

            await expect(
                nativeRequest.connect(merchant).createRequests(
                    tooLarge,
                    0,
                    1,
                    "Too large"
                )
            ).to.be.revertedWith("Amount too large");
        });

        it("Should keep later batch ranges isolated", async function () {
            const amount = ethers.parseEther("0.1");

            await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                2,
                "Batch one"
            );

            const second = await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                3,
                "Batch two"
            );

            expect(second.firstRequestId).to.equal(11n);

            await nativeRequest.connect(payer).payRequest(
                second.firstRequestId,
                { value: amount }
            );

            await nativeRequest.connect(merchant).cancelRequest(
                second.firstRequestId + 1n
            );

            const paid = (await nativeRequest.getRequest(second.firstRequestId))[0];
            const cancelled = (await nativeRequest.getRequest(second.firstRequestId + 1n))[0];
            const open = (await nativeRequest.getRequest(second.firstRequestId + 2n))[0];

            expect(paid.batchId).to.equal(2n);
            expect(paid.status).to.equal(1n);

            expect(cancelled.batchId).to.equal(2n);
            expect(cancelled.status).to.equal(2n);

            expect(open.batchId).to.equal(2n);
            expect(open.status).to.equal(0n);

            expect((await nativeRequest.getRequest(1))[0].status).to.equal(0n);
            expect((await nativeRequest.getRequest(2))[0].status).to.equal(0n);
        });

        it("Should cancel open requests correctly in a later reserved batch range", async function () {
            const amount = ethers.parseEther("0.1");

            await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                1,
                "First batch"
            );

            const second = await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                3,
                "Second batch"
            );

            expect(second.firstRequestId).to.equal(11n);

            await nativeRequest.connect(payer).payRequest(
                second.firstRequestId,
                { value: amount }
            );

            await expect(
                nativeRequest.connect(merchant).cancelBatch(second.batchId)
            ).to.emit(nativeRequest, "RequestBatchCancelled")
                .withArgs(
                    second.batchId,
                    merchant.address,
                    2n
                );

            expect(
                (await nativeRequest.getRequest(second.firstRequestId))[0].status
            ).to.equal(1n);

            expect(
                (await nativeRequest.getRequest(second.firstRequestId + 1n))[0].status
            ).to.equal(2n);

            expect(
                (await nativeRequest.getRequest(second.firstRequestId + 2n))[0].status
            ).to.equal(2n);
        });
    });

    describe("Fee calculation", function () {
        it("Should calculate exactly 0.5 percent", async function () {
            const amount = ethers.parseEther("1");
            const expectedFee = ethers.parseEther("0.005");

            expect(await nativeRequest.calculateFee(amount)).to.equal(expectedFee);
        });

        it("Should calculate 0.125 DOC fee on 25 DOC", async function () {
            const amount = ethers.parseUnits("25", 6);
            const expectedFee = ethers.parseUnits("0.125", 6);

            expect(await tokenRequest.calculateFee(amount)).to.equal(expectedFee);
        });

        it("Should round fee down using integer division", async function () {
            expect(await nativeRequest.calculateFee(199)).to.equal(0n);
            expect(await nativeRequest.calculateFee(200)).to.equal(1n);
            expect(await nativeRequest.calculateFee(399)).to.equal(1n);
            expect(await nativeRequest.calculateFee(400)).to.equal(2n);
        });

        it("Should preserve gross = merchant amount + fee", async function () {
            const amount = ethers.parseUnits("123.456789", 6);
            const fee = await tokenRequest.calculateFee(amount);
            const merchantAmount = amount - fee;

            expect(merchantAmount + fee).to.equal(amount);
        });
    });

    describe("Native payments", function () {
        it("Should pay a native request and distribute merchant amount and fee", async function () {
            const amount = ethers.parseEther("1");
            const fee = await nativeRequest.calculateFee(amount);
            const merchantAmount = amount - fee;

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                1,
                "Native payment"
            );

            await expect(
                nativeRequest.connect(payer).payRequest(firstRequestId, {
                    value: amount
                })
            ).to.changeEtherBalances(
                [merchant, commissionWallet],
                [merchantAmount, fee]
            );

            const result = await nativeRequest.getRequest(firstRequestId);
            const paymentRequest = result[0];

            expect(paymentRequest.status).to.equal(1n);
            expect(paymentRequest.payer).to.equal(payer.address);
            expect(paymentRequest.paidAt).to.be.greaterThan(0n);

            expect(
                await ethers.provider.getBalance(await nativeRequest.getAddress())
            ).to.equal(0n);
        });

        it("Should emit RequestPaid correctly for native asset", async function () {
            const amount = ethers.parseEther("2");
            const fee = await nativeRequest.calculateFee(amount);
            const merchantAmount = amount - fee;

            const { batchId, firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                1,
                "Event payment"
            );

            await expect(
                nativeRequest.connect(payer).payRequest(firstRequestId, {
                    value: amount
                })
            ).to.emit(nativeRequest, "RequestPaid")
                .withArgs(
                    firstRequestId,
                    batchId,
                    payer.address,
                    merchant.address,
                    amount,
                    merchantAmount,
                    fee
                );
        });

        it("Should reject native payment below requested amount", async function () {
            const amount = ethers.parseEther("1");

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount
            );

            await expect(
                nativeRequest.connect(payer).payRequest(firstRequestId, {
                    value: amount - 1n
                })
            ).to.be.revertedWith("Incorrect payment amount");

            const result = await nativeRequest.getRequest(firstRequestId);
            expect(result[0].status).to.equal(0n);
        });

        it("Should reject native payment above requested amount", async function () {
            const amount = ethers.parseEther("1");

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount
            );

            await expect(
                nativeRequest.connect(payer).payRequest(firstRequestId, {
                    value: amount + 1n
                })
            ).to.be.revertedWith("Incorrect payment amount");

            const result = await nativeRequest.getRequest(firstRequestId);
            expect(result[0].status).to.equal(0n);
        });

        it("Should prevent double payment", async function () {
            const amount = ethers.parseEther("1");

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount
            );

            await nativeRequest.connect(payer).payRequest(firstRequestId, {
                value: amount
            });

            await expect(
                nativeRequest.connect(payer2).payRequest(firstRequestId, {
                    value: amount
                })
            ).to.be.revertedWith("Request is not open");
        });

        it("Should reject payment of cancelled request", async function () {
            const amount = ethers.parseEther("1");

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount
            );

            await nativeRequest.connect(merchant).cancelRequest(firstRequestId);

            await expect(
                nativeRequest.connect(payer).payRequest(firstRequestId, {
                    value: amount
                })
            ).to.be.revertedWith("Request is not open");
        });

        it("Should reject payment of expired request", async function () {
            const amount = ethers.parseEther("1");
            const expiration = BigInt(await time.latest()) + 100n;

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount,
                expiration
            );

            await time.increaseTo(expiration + 1n);

            await expect(
                nativeRequest.connect(payer).payRequest(firstRequestId, {
                    value: amount
                })
            ).to.be.revertedWith("Request expired");

            const result = await nativeRequest.getRequest(firstRequestId);
            expect(result[0].status).to.equal(0n);
        });

        it("Should reject nonexistent request", async function () {
            await expect(
                nativeRequest.connect(payer).payRequest(999, {
                    value: ethers.parseEther("1")
                })
            ).to.be.revertedWith("Request not found");
        });

        it("Should reject native value when contract is configured for ERC20", async function () {
            const amount = ethers.parseUnits("25", 6);

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await expect(
                tokenRequest.connect(payer).payRequest(firstRequestId, {
                    value: ethers.parseEther("1")
                })
            ).to.be.revertedWith("Native value not accepted");
        });
    });

    describe("ERC20 payments", function () {
        it("Should pay ERC20 request and distribute merchant amount and fee", async function () {
            const amount = ethers.parseUnits("25", 6);
            const fee = await tokenRequest.calculateFee(amount);
            const merchantAmount = amount - fee;

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount,
                0,
                1,
                "25 DOC"
            );

            const payerBalanceBefore = await token6.balanceOf(payer.address);
            const merchantBalanceBefore = await token6.balanceOf(merchant.address);
            const commissionBalanceBefore = await token6.balanceOf(commissionWallet.address);

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                amount
            );

            await tokenRequest.connect(payer).payRequest(firstRequestId);

            expect(
                await token6.balanceOf(payer.address)
            ).to.equal(payerBalanceBefore - amount);

            expect(
                await token6.balanceOf(merchant.address)
            ).to.equal(merchantBalanceBefore + merchantAmount);

            expect(
                await token6.balanceOf(commissionWallet.address)
            ).to.equal(commissionBalanceBefore + fee);

            expect(
                await token6.balanceOf(await tokenRequest.getAddress())
            ).to.equal(0n);

            const result = await tokenRequest.getRequest(firstRequestId);

            expect(result[0].status).to.equal(1n);
            expect(result[0].payer).to.equal(payer.address);
            expect(result[0].paidAt).to.be.greaterThan(0n);
        });

        it("Should consume exact allowance when exact amount is approved", async function () {
            const amount = ethers.parseUnits("25", 6);

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                amount
            );

            await tokenRequest.connect(payer).payRequest(firstRequestId);

            expect(
                await token6.allowance(
                    payer.address,
                    await tokenRequest.getAddress()
                )
            ).to.equal(0n);
        });

        it("Should preserve remaining allowance when larger approval exists", async function () {
            const amount = ethers.parseUnits("25", 6);
            const allowance = ethers.parseUnits("100", 6);

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                allowance
            );

            await tokenRequest.connect(payer).payRequest(firstRequestId);

            expect(
                await token6.allowance(
                    payer.address,
                    await tokenRequest.getAddress()
                )
            ).to.equal(allowance - amount);
        });

        it("Should reject payment without allowance", async function () {
            const amount = ethers.parseUnits("25", 6);

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await expect(
                tokenRequest.connect(payer).payRequest(firstRequestId)
            ).to.be.revertedWith("Token transferFrom failed");

            const result = await tokenRequest.getRequest(firstRequestId);

            expect(result[0].status).to.equal(0n);
            expect(result[0].payer).to.equal(ZERO_ADDRESS);
            expect(result[0].paidAt).to.equal(0n);
        });

        it("Should reject insufficient allowance and rollback state", async function () {
            const amount = ethers.parseUnits("25", 6);

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                amount - 1n
            );

            await expect(
                tokenRequest.connect(payer).payRequest(firstRequestId)
            ).to.be.revertedWith("Token transferFrom failed");

            const result = await tokenRequest.getRequest(firstRequestId);

            expect(result[0].status).to.equal(0n);
            expect(result[0].payer).to.equal(ZERO_ADDRESS);
        });

        it("Should reject insufficient token balance and rollback state", async function () {
            const amount = ethers.parseUnits("200000", 6);

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                amount
            );

            await expect(
                tokenRequest.connect(payer).payRequest(firstRequestId)
            ).to.be.revertedWith("Token transferFrom failed");

            const result = await tokenRequest.getRequest(firstRequestId);
            expect(result[0].status).to.equal(0n);
        });

        it("Should work with an 18-decimal ERC20 without contract changes", async function () {
            const request18 = await deployRequest(
                commissionWallet.address,
                await token18.getAddress()
            );

            const amount = ethers.parseUnits("10", 18);
            const fee = await request18.calculateFee(amount);
            const merchantAmount = amount - fee;

            const { firstRequestId } = await createRequests(
                request18,
                merchant,
                amount
            );

            await token18.connect(payer).approve(
                await request18.getAddress(),
                amount
            );

            await request18.connect(payer).payRequest(firstRequestId);

            expect(
                await token18.balanceOf(merchant.address)
            ).to.equal(merchantAmount);

            expect(
                await token18.balanceOf(commissionWallet.address)
            ).to.equal(fee);
        });

        it("Should support ERC20 tokens that return no value from transferFrom", async function () {
            const MockERC20NoReturn = await ethers.getContractFactory("MockERC20NoReturn");

            const noReturnToken = await MockERC20NoReturn.deploy(6);
            await noReturnToken.waitForDeployment();

            const noReturnRequest = await deployRequest(
                commissionWallet.address,
                await noReturnToken.getAddress()
            );

            const amount = ethers.parseUnits("100", 6);
            const fee = await noReturnRequest.calculateFee(amount);
            const merchantAmount = amount - fee;

            await noReturnToken.mint(payer.address, amount);

            const { firstRequestId } = await createRequests(
                noReturnRequest,
                merchant,
                amount
            );

            await noReturnToken.connect(payer).approve(
                await noReturnRequest.getAddress(),
                amount
            );

            await noReturnRequest.connect(payer).payRequest(firstRequestId);

            expect(
                await noReturnToken.balanceOf(merchant.address)
            ).to.equal(merchantAmount);

            expect(
                await noReturnToken.balanceOf(commissionWallet.address)
            ).to.equal(fee);

            expect(
                await noReturnToken.balanceOf(await noReturnRequest.getAddress())
            ).to.equal(0n);
        });

        it("Should reject ERC20 tokens returning false", async function () {
            const MockERC20FalseReturn = await ethers.getContractFactory("MockERC20FalseReturn");

            const falseToken = await MockERC20FalseReturn.deploy();
            await falseToken.waitForDeployment();

            const falseRequest = await deployRequest(
                commissionWallet.address,
                await falseToken.getAddress()
            );

            const amount = 1000000n;

            const { firstRequestId } = await createRequests(
                falseRequest,
                merchant,
                amount
            );

            await falseToken.connect(payer).approve(
                await falseRequest.getAddress(),
                amount
            );

            await expect(
                falseRequest.connect(payer).payRequest(firstRequestId)
            ).to.be.revertedWith("Token transferFrom returned false");

            const result = await falseRequest.getRequest(firstRequestId);

            expect(result[0].status).to.equal(0n);
            expect(result[0].payer).to.equal(ZERO_ADDRESS);
        });

        it("Should prevent ERC20 double payment", async function () {
            const amount = ethers.parseUnits("25", 6);

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                amount
            );

            await tokenRequest.connect(payer).payRequest(firstRequestId);

            await token6.connect(payer2).approve(
                await tokenRequest.getAddress(),
                amount
            );

            await expect(
                tokenRequest.connect(payer2).payRequest(firstRequestId)
            ).to.be.revertedWith("Request is not open");
        });

        it("Should emit RequestPaid correctly for ERC20", async function () {
            const amount = ethers.parseUnits("50", 6);
            const fee = await tokenRequest.calculateFee(amount);
            const merchantAmount = amount - fee;

            const { batchId, firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                amount
            );

            await expect(
                tokenRequest.connect(payer).payRequest(firstRequestId)
            ).to.emit(tokenRequest, "RequestPaid")
                .withArgs(
                    firstRequestId,
                    batchId,
                    payer.address,
                    merchant.address,
                    amount,
                    merchantAmount,
                    fee
                );
        });
    });

    describe("Individual cancellation", function () {
        it("Should allow merchant to cancel an open request", async function () {
            const { batchId, firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1")
            );

            await expect(
                nativeRequest.connect(merchant).cancelRequest(firstRequestId)
            ).to.emit(nativeRequest, "RequestCancelled")
                .withArgs(
                    firstRequestId,
                    batchId,
                    merchant.address
                );

            const result = await nativeRequest.getRequest(firstRequestId);

            expect(result[0].status).to.equal(2n);
        });

        it("Should reject cancellation by another account", async function () {
            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1")
            );

            await expect(
                nativeRequest.connect(other).cancelRequest(firstRequestId)
            ).to.be.revertedWith("Only merchant");
        });

        it("Should reject cancellation of nonexistent request", async function () {
            await expect(
                nativeRequest.connect(merchant).cancelRequest(999)
            ).to.be.revertedWith("Request not found");
        });

        it("Should reject second cancellation", async function () {
            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1")
            );

            await nativeRequest.connect(merchant).cancelRequest(firstRequestId);

            await expect(
                nativeRequest.connect(merchant).cancelRequest(firstRequestId)
            ).to.be.revertedWith("Request is not open");
        });

        it("Should reject cancellation after payment", async function () {
            const amount = ethers.parseEther("1");

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount
            );

            await nativeRequest.connect(payer).payRequest(firstRequestId, {
                value: amount
            });

            await expect(
                nativeRequest.connect(merchant).cancelRequest(firstRequestId)
            ).to.be.revertedWith("Request is not open");
        });

        it("Should allow merchant to cancel an expired but still open request", async function () {
            const expiration = BigInt(await time.latest()) + 100n;

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                expiration
            );

            await time.increaseTo(expiration + 1n);

            await expect(
                nativeRequest.connect(merchant).cancelRequest(firstRequestId)
            ).to.not.be.reverted;

            const result = await nativeRequest.getRequest(firstRequestId);

            expect(result[0].status).to.equal(2n);
        });
    });

    describe("Batch cancellation", function () {
        it("Should cancel every open request in a batch", async function () {
            const { batchId, firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                10,
                "Cancel entire batch"
            );

            await expect(
                nativeRequest.connect(merchant).cancelBatch(batchId)
            ).to.emit(nativeRequest, "RequestBatchCancelled")
                .withArgs(
                    batchId,
                    merchant.address,
                    10n
                );

            for (let i = 0n; i < 10n; i++) {
                const result = await nativeRequest.getRequest(firstRequestId + i);
                expect(result[0].status).to.equal(2n);
            }
        });

        it("Should preserve paid requests and cancel remaining open requests", async function () {
            const amount = ethers.parseEther("1");

            const { batchId, firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                5,
                "Mixed batch"
            );

            await nativeRequest.connect(payer).payRequest(firstRequestId, {
                value: amount
            });

            await nativeRequest.connect(merchant).cancelRequest(
                firstRequestId + 1n
            );

            await expect(
                nativeRequest.connect(merchant).cancelBatch(batchId)
            ).to.emit(nativeRequest, "RequestBatchCancelled")
                .withArgs(
                    batchId,
                    merchant.address,
                    3n
                );

            expect((await nativeRequest.getRequest(firstRequestId))[0].status).to.equal(1n);
            expect((await nativeRequest.getRequest(firstRequestId + 1n))[0].status).to.equal(2n);
            expect((await nativeRequest.getRequest(firstRequestId + 2n))[0].status).to.equal(2n);
            expect((await nativeRequest.getRequest(firstRequestId + 3n))[0].status).to.equal(2n);
            expect((await nativeRequest.getRequest(firstRequestId + 4n))[0].status).to.equal(2n);
        });

        it("Should reject batch cancellation by another account", async function () {
            const { batchId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                3
            );

            await expect(
                nativeRequest.connect(other).cancelBatch(batchId)
            ).to.be.revertedWith("Only merchant");
        });

        it("Should reject cancellation of nonexistent batch", async function () {
            await expect(
                nativeRequest.connect(merchant).cancelBatch(999)
            ).to.be.revertedWith("Batch not found");
        });

        it("Should reject batch cancellation when no request remains open", async function () {
            const { batchId, firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                0,
                2
            );

            await nativeRequest.connect(merchant).cancelRequest(firstRequestId);
            await nativeRequest.connect(merchant).cancelRequest(firstRequestId + 1n);

            await expect(
                nativeRequest.connect(merchant).cancelBatch(batchId)
            ).to.be.revertedWith("No open requests");
        });
    });

    describe("Expiration", function () {
        it("Should report a request without expiration as not expired", async function () {
            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1")
            );

            expect(
                await nativeRequest.isExpired(firstRequestId)
            ).to.equal(false);
        });

        it("Should report future request as not expired", async function () {
            const expiration = BigInt(await time.latest()) + 3600n;

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                expiration
            );

            expect(
                await nativeRequest.isExpired(firstRequestId)
            ).to.equal(false);
        });

        it("Should report request as expired after expiration timestamp", async function () {
            const expiration = BigInt(await time.latest()) + 100n;

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1"),
                expiration
            );

            await time.increaseTo(expiration + 1n);

            expect(
                await nativeRequest.isExpired(firstRequestId)
            ).to.equal(true);
        });

        it("Should revert expiration query for nonexistent request", async function () {
            await expect(
                nativeRequest.isExpired(999)
            ).to.be.revertedWith("Request not found");
        });
    });

    describe("Views and pagination", function () {
        it("Should reject getRequest for nonexistent request", async function () {
            await expect(
                nativeRequest.getRequest(999)
            ).to.be.revertedWith("Request not found");
        });

        it("Should reject getBatch for nonexistent batch", async function () {
            await expect(
                nativeRequest.getBatch(999)
            ).to.be.revertedWith("Batch not found");
        });

        it("Should return paginated merchant batches", async function () {
            for (let i = 0; i < 7; i++) {
                await createRequests(
                    nativeRequest,
                    merchant,
                    ethers.parseEther("0.01"),
                    0,
                    1,
                    `Batch ${i + 1}`
                );
            }

            const page1 = await nativeRequest.getBatchIdsByMerchantSlice(
                merchant.address,
                0,
                3
            );

            const page2 = await nativeRequest.getBatchIdsByMerchantSlice(
                merchant.address,
                3,
                3
            );

            const page3 = await nativeRequest.getBatchIdsByMerchantSlice(
                merchant.address,
                6,
                3
            );

            expect(page1).to.deep.equal([1n, 2n, 3n]);
            expect(page2).to.deep.equal([4n, 5n, 6n]);
            expect(page3).to.deep.equal([7n]);
        });

        it("Should return empty array when offset is outside range", async function () {
            await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1")
            );

            const result = await nativeRequest.getBatchIdsByMerchantSlice(
                merchant.address,
                10,
                5
            );

            expect(result.length).to.equal(0);
        });

        it("Should return empty array when limit is zero", async function () {
            await createRequests(
                nativeRequest,
                merchant,
                ethers.parseEther("1")
            );

            const result = await nativeRequest.getBatchIdsByMerchantSlice(
                merchant.address,
                0,
                0
            );

            expect(result.length).to.equal(0);
        });

        it("Should report correct totals across multiple merchants", async function () {
            await createRequests(nativeRequest, merchant, ethers.parseEther("1"), 0, 3);
            await createRequests(nativeRequest, other, ethers.parseEther("1"), 0, 7);
            await createRequests(nativeRequest, merchant, ethers.parseEther("1"), 0, 10);

            expect(await nativeRequest.totalBatches()).to.equal(3n);
            expect(await nativeRequest.totalRequests()).to.equal(20n);
        });
    });

    describe("Atomicity and failure handling", function () {
        it("Should rollback request state if native merchant transfer fails", async function () {
            const RejectNativeReceiver = await ethers.getContractFactory("RejectNativeReceiver");

            const rejectingMerchant = await RejectNativeReceiver.deploy(
                await nativeRequest.getAddress()
            );

            await rejectingMerchant.waitForDeployment();

            const amount = ethers.parseEther("1");

            await rejectingMerchant.createRequest(
                amount,
                0,
                1,
                "Reject payment"
            );

            await expect(
                nativeRequest.connect(payer).payRequest(1, {
                    value: amount
                })
            ).to.be.revertedWith("Native transfer failed");

            const result = await nativeRequest.getRequest(1);

            expect(result[0].status).to.equal(0n);
            expect(result[0].payer).to.equal(ZERO_ADDRESS);
            expect(result[0].paidAt).to.equal(0n);

            expect(
                await ethers.provider.getBalance(await nativeRequest.getAddress())
            ).to.equal(0n);
        });

        it("Should rollback entire native payment if commission transfer fails", async function () {
            const temporaryRequest = await deployRequest(
                commissionWallet.address,
                ZERO_ADDRESS
            );

            const RejectNativeReceiver = await ethers.getContractFactory("RejectNativeReceiver");

            const rejectingCommission = await RejectNativeReceiver.deploy(
                await temporaryRequest.getAddress()
            );

            await rejectingCommission.waitForDeployment();

            const requestWithRejectingCommission = await deployRequest(
                await rejectingCommission.getAddress(),
                ZERO_ADDRESS
            );

            const amount = ethers.parseEther("1");

            const { firstRequestId } = await createRequests(
                requestWithRejectingCommission,
                merchant,
                amount
            );

            const merchantBalanceBefore = await ethers.provider.getBalance(
                merchant.address
            );

            await expect(
                requestWithRejectingCommission.connect(payer).payRequest(
                    firstRequestId,
                    {
                        value: amount
                    }
                )
            ).to.be.revertedWith("Native transfer failed");

            expect(
                await ethers.provider.getBalance(merchant.address)
            ).to.equal(merchantBalanceBefore);

            const result = await requestWithRejectingCommission.getRequest(
                firstRequestId
            );

            expect(result[0].status).to.equal(0n);
            expect(result[0].payer).to.equal(ZERO_ADDRESS);
        });

        it("Should rollback ERC20 payment when second transfer fails", async function () {
            const amount = ethers.parseUnits("25", 6);
            const fee = await tokenRequest.calculateFee(amount);
            const merchantAmount = amount - fee;

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount
            );

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                merchantAmount
            );

            await expect(
                tokenRequest.connect(payer).payRequest(firstRequestId)
            ).to.be.revertedWith("Token transferFrom failed");

            expect(
                await token6.balanceOf(merchant.address)
            ).to.equal(0n);

            expect(
                await token6.balanceOf(commissionWallet.address)
            ).to.equal(0n);

            const result = await tokenRequest.getRequest(firstRequestId);

            expect(result[0].status).to.equal(0n);
            expect(result[0].payer).to.equal(ZERO_ADDRESS);
        });
    });

    describe("Reentrancy protection by state transition", function () {
        it("Should prevent reentrant payment of the same native request", async function () {
            const amount = ethers.parseEther("1");
            const fee = await nativeRequest.calculateFee(amount);

            const ReentrantMerchant = await ethers.getContractFactory("ReentrantMerchant");

            const reentrantMerchant = await ReentrantMerchant.deploy(
                await nativeRequest.getAddress()
            );

            await reentrantMerchant.waitForDeployment();

            await payer.sendTransaction({
                to: await reentrantMerchant.getAddress(),
                value: fee
            });

            await reentrantMerchant.createRequest(
                amount,
                0,
                1,
                "Reentrancy test"
            );

            await reentrantMerchant.armAttack(1, amount);

            await expect(
                nativeRequest.connect(payer).payRequest(1, {
                    value: amount
                })
            ).to.not.be.reverted;

            expect(
                await reentrantMerchant.attackAttempted()
            ).to.equal(true);

            expect(
                await reentrantMerchant.attackSucceeded()
            ).to.equal(false);

            const result = await nativeRequest.getRequest(1);

            expect(result[0].status).to.equal(1n);
            expect(result[0].payer).to.equal(payer.address);

            expect(
                await ethers.provider.getBalance(await nativeRequest.getAddress())
            ).to.equal(0n);
        });
    });

    describe("Multiple requests lifecycle", function () {
        it("Should manage paid, cancelled and open requests independently in same batch", async function () {
            const amount = ethers.parseEther("0.1");

            const { firstRequestId } = await createRequests(
                nativeRequest,
                merchant,
                amount,
                0,
                5,
                "Independent requests"
            );

            await nativeRequest.connect(payer).payRequest(
                firstRequestId,
                {
                    value: amount
                }
            );

            await nativeRequest.connect(payer2).payRequest(
                firstRequestId + 1n,
                {
                    value: amount
                }
            );

            await nativeRequest.connect(merchant).cancelRequest(
                firstRequestId + 2n
            );

            expect(
                (await nativeRequest.getRequest(firstRequestId))[0].status
            ).to.equal(1n);

            expect(
                (await nativeRequest.getRequest(firstRequestId + 1n))[0].status
            ).to.equal(1n);

            expect(
                (await nativeRequest.getRequest(firstRequestId + 2n))[0].status
            ).to.equal(2n);

            expect(
                (await nativeRequest.getRequest(firstRequestId + 3n))[0].status
            ).to.equal(0n);

            expect(
                (await nativeRequest.getRequest(firstRequestId + 4n))[0].status
            ).to.equal(0n);
        });

        it("Should allow different payers to pay different requests from same batch", async function () {
            const amount = ethers.parseUnits("10", 6);

            const { firstRequestId } = await createRequests(
                tokenRequest,
                merchant,
                amount,
                0,
                2,
                "Two customers"
            );

            await token6.connect(payer).approve(
                await tokenRequest.getAddress(),
                amount
            );

            await token6.connect(payer2).approve(
                await tokenRequest.getAddress(),
                amount
            );

            await tokenRequest.connect(payer).payRequest(firstRequestId);
            await tokenRequest.connect(payer2).payRequest(firstRequestId + 1n);

            const request1 = (await tokenRequest.getRequest(firstRequestId))[0];
            const request2 = (await tokenRequest.getRequest(firstRequestId + 1n))[0];

            expect(request1.payer).to.equal(payer.address);
            expect(request2.payer).to.equal(payer2.address);

            expect(request1.status).to.equal(1n);
            expect(request2.status).to.equal(1n);
        });
    });
});