const { ethers, tracer } = require('hardhat');
const { expect, time, constants, trim0x, getPermit2, permit2Contract } = require('@1inch/solidity-utils');
const { fillWithMakingAmount, unwrapWethTaker, skipMakerPermit, buildMakerTraits, buildOrder, signOrder, compactSignature, buildOrderData } = require('./helpers/orderUtils');
const { getPermit, withTarget } = require('./helpers/eip712');
const { joinStaticCalls, cutLastArg, ether, findTrace, countAllItems } = require('./helpers/utils');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { deploySwapTokens } = require('./helpers/fixtures');

describe('LimitOrderProtocol', function () {
    let addr, addr1, addr2;

    before(async function () {
        [addr, addr1, addr2] = await ethers.getSigners();
    });

    async function initContracts (dai, weth, swap) {
        await dai.mint(addr1.address, ether('1000000'));
        await dai.mint(addr.address, ether('1000000'));
        await weth.deposit({ value: ether('100') });
        await weth.connect(addr1).deposit({ value: ether('100') });
        await dai.approve(swap.address, ether('1000000'));
        await dai.connect(addr1).approve(swap.address, ether('1000000'));
        await weth.approve(swap.address, ether('100'));
        await weth.connect(addr1).approve(swap.address, ether('100'));
    };

    describe('wip', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId };
        };

        it('transferFrom', async function () {
            const { dai } = await loadFixture(deployContractsAndInit);

            await dai.connect(addr1).approve(addr.address, '2');
            await dai.transferFrom(addr1.address, addr.address, '1');
        });

        it('should not swap with bad signature', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
            });

            const fakeOrder = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 2,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(fakeOrder, r, vs, 1, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'BadSignature');
        });

        it('should not fill above threshold', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 2,
                takingAmount: 2,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 2, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'TakingAmountTooHigh');
        });

        it('should not fill below threshold', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 2,
                takingAmount: 2,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 2, 3))
                .to.be.revertedWithCustomError(swap, 'MakingAmountTooLow');
        });

        it('should fill without checks with threshold == 0', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 2,
                takingAmount: 10,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ allowMultipleFills: true }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));

            const swapWithoutThreshold = await swap.fillOrder(order, r, vs, 5, 0);
            const gasUsedWithoutThreshold = (await swapWithoutThreshold.wait()).gasUsed;
            await loadFixture(deployContractsAndInit);
            const swapWithThreshold = await swap.fillOrder(order, r, vs, 5, 1);
            expect((await swapWithThreshold.wait()).gasUsed).to.gt(gasUsedWithoutThreshold);
        });

        it('should fail when amount is zero', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 100,
                takingAmount: 1,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 0, 0))
                .to.be.revertedWithCustomError(swap, 'SwapWithZeroAmount');
        });

        it('@skip-on-coverage should swap fully based on signature', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 1 DAI => 1 WETH
            // Swap:  1 DAI => 1 WETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)))
                .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);

            const trace = findTrace(tracer, 'CALL', swap.address);
            const opcodes = trace.children.map(item => item.opcode);
            expect(countAllItems(opcodes)).to.deep.equal({ STATICCALL: 1, CALL: 2, SLOAD: 1, SSTORE: 1, LOG1: 1 });
        });

        it('@skip-on-coverage should swap half based on signature', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 2 DAI => 2 WETH
            // Swap:  1 DAI => 1 WETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 2,
                takingAmount: 2,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)))
                .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);

            const trace = findTrace(tracer, 'CALL', swap.address);
            const opcodes = trace.children.map(item => item.opcode);
            expect(countAllItems(opcodes)).to.deep.equal({ STATICCALL: 1, CALL: 2, SLOAD: 1, SSTORE: 1, LOG1: 1 });
        });

        it('should floor maker amount', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 2 DAI => 10 WETH
            // Swap:  9 WETH <= 1 DAI

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 2,
                takingAmount: 10,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 9, 1))
                .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                .to.changeTokenBalances(weth, [addr, addr1], [-9, 9]);
        });

        it('should fail on floor maker amount = 0', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 2 DAI => 10 WETH
            // Swap:  4 WETH <= 0 DAI

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 2,
                takingAmount: 10,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 4, 0))
                .to.be.revertedWithCustomError(swap, 'SwapWithZeroAmount');
        });

        it('should ceil taker amount', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 10 DAI => 2 WETH
            // Swap:  4 DAI => 1 WETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 2,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 4, fillWithMakingAmount(1)))
                .to.changeTokenBalances(dai, [addr, addr1], [4, -4])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });

        it('should unwrap weth', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 10 DAI => 2 WETH
            // Swap:  4 DAI => 1 WETH

            const order = buildOrder({
                makerAsset: weth.address,
                takerAsset: dai.address,
                makingAmount: ether('2'),
                takingAmount: ether('10'),
                maker: addr1.address,
            });

            await weth.connect(addr1).deposit({ value: ether('2') });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, ether('5'), unwrapWethTaker(ether('1'))))
                .to.changeTokenBalances(dai, [addr, addr1], [ether('-5'), ether('5')])
                .to.changeTokenBalances(weth, [addr, addr1], [ether('0'), ether('-1')])
                .to.changeEtherBalance(addr, ether('1'));
        });

        it('ERC721Proxy should work', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const ERC721Proxy = await ethers.getContractFactory('ERC721Proxy');
            const erc721proxy = await ERC721Proxy.deploy(swap.address);
            await erc721proxy.deployed();

            await dai.connect(addr1).approve(erc721proxy.address, '10');
            await weth.approve(erc721proxy.address, '10');

            const order = buildOrder(
                {
                    makerAsset: erc721proxy.address,
                    takerAsset: erc721proxy.address,
                    makingAmount: 10,
                    takingAmount: 10,
                    maker: addr1.address,
                },
                {
                    makerAssetSuffix: '0x' + erc721proxy.interface.encodeFunctionData('func_60iHVgK', [addr1.address, constants.ZERO_ADDRESS, 0, 10, dai.address]).substring(202),
                    takerAssetSuffix: '0x' + erc721proxy.interface.encodeFunctionData('func_60iHVgK', [constants.ZERO_ADDRESS, addr1.address, 0, 10, weth.address]).substring(202),
                },
            );

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrderExt(order, r, vs, 10, fillWithMakingAmount(10), order.extension))
                .to.changeTokenBalances(dai, [addr, addr1], [10, -10])
                .to.changeTokenBalances(weth, [addr, addr1], [-10, 10]);
        });
    });

    describe('MakerTraits', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            const TakerIncreaser = await ethers.getContractFactory('TakerIncreaser');
            const takerIncreaser = await TakerIncreaser.deploy();
            return { dai, weth, swap, chainId, takerIncreaser };
        };

        it('disallow multiple fills', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 10 DAI => 2 WETH
            // Swap:  4 DAI => 1 WETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 2,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ allowMultipleFills: false }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 4, fillWithMakingAmount(1)))
                .to.changeTokenBalances(dai, [addr, addr1], [4, -4])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);

            await expect(swap.fillOrder(order, r, vs, 4, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'BitInvalidatedOrder');
        });

        it('need epoch manager, success', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 10 DAI => 2 WETH
            // Swap:  4 DAI => 1 WETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 2,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ shouldCheckEpoch: true }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 4, fillWithMakingAmount(1)))
                .to.changeTokenBalances(dai, [addr, addr1], [4, -4])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });

        it('need epoch manager, fail', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 10 DAI => 2 WETH
            // Swap:  4 DAI => 1 WETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 2,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ shouldCheckEpoch: true, nonce: 1 }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 4, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'WrongSeriesNonce');
        });

        it('expired order', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 10 DAI => 2 WETH
            // Swap:  4 DAI => 1 WETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 2,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ expiry: await time.latest() }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 4, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'OrderExpired');
        });

        it('unwrap weth for maker', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);
            // Order: 10 DAI => 2 WETH
            // Swap:  10 DAI => 2 ETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 2,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ unwrapWeth: true }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 10, fillWithMakingAmount(2)))
                .to.changeTokenBalances(dai, [addr, addr1], [10, -10])
                .to.changeTokenBalance(weth, addr, -2)
                .to.changeEtherBalance(addr1, 2);
        });

        it('Allow taker rate improvement', async function () {
            const { dai, weth, swap, chainId, takerIncreaser } = await loadFixture(deployContractsAndInit);
            // Order: 10 DAI => 2 WETH
            // Swap:  10 DAI => 3 WETH

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 2,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ allowPriceImprovement: true }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrderTo(order, r, vs, 10, 2, addr.address, takerIncreaser.address))
                .to.changeTokenBalances(dai, [addr, addr1], [10, -10])
                .to.changeTokenBalances(weth, [addr, addr1], [-3, 3]);
        });
    });

    describe('Permit', function () {
        describe('fillOrderToWithPermit', function () {
            const deployContractsAndInitPermit = async function () {
                const { dai, weth, swap, chainId } = await deploySwapTokens();
                await initContracts(dai, weth, swap);

                const order = buildOrder({
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: 1,
                    takingAmount: 1,
                    maker: addr1.address,
                });
                const signature = await signOrder(order, chainId, swap.address, addr1);

                return { dai, weth, swap, chainId, order, signature };
            };

            it('DAI => WETH', async function () {
                const { dai, weth, swap, chainId, order, signature } = await loadFixture(deployContractsAndInitPermit);

                const permit = await getPermit(addr.address, addr, weth, '1', chainId, swap.address, '1');
                const { r, vs } = compactSignature(signature);
                await expect(swap.fillOrderToWithPermit(order, r, vs, 1, fillWithMakingAmount(1), addr.address, '0x', permit))
                    .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                    .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
            });

            it('DAI => WETH, permit2 maker', async function () {
                const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInitPermit);

                const permit2 = await permit2Contract();
                await dai.connect(addr1).approve(permit2.address, 1);
                const permit = await getPermit2(addr1, dai.address, chainId, swap.address, 1);

                const order = buildOrder({
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: 1,
                    takingAmount: 1,
                    maker: addr1.address,
                    makerTraits: buildMakerTraits({ usePermit2: true }),
                });

                const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
                await expect(swap.fillOrderToWithPermit(order, r, vs, 1, fillWithMakingAmount(1), addr.address, '0x', permit))
                    .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                    .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
            });

            it('rejects reused permit', async function () {
                const { weth, swap, chainId, order, signature } = await loadFixture(deployContractsAndInitPermit);

                const permit = await getPermit(addr.address, addr, weth, '1', chainId, swap.address, '1');

                const { r, vs } = compactSignature(signature);
                await swap.fillOrderToWithPermit(order, r, vs, 1, 1, addr.address, '0x', permit);
                await expect(swap.fillOrderToWithPermit(order, r, vs, 1, 1, addr.address, '0x', permit))
                    .to.be.revertedWith('ERC20Permit: invalid signature');
            });

            it('rejects wrong signature', async function () {
                const { weth, swap, chainId, order, signature } = await loadFixture(deployContractsAndInitPermit);

                const permit = await getPermit(addr.address, addr2, weth, '1', chainId, swap.address, '1');

                const { r, vs } = compactSignature(signature);
                await expect(swap.fillOrderToWithPermit(order, r, vs, 1, 1, addr.address, '0x', permit))
                    .to.be.revertedWith('ERC20Permit: invalid signature');
            });

            it('rejects expired permit', async function () {
                const { weth, swap, chainId, order, signature } = await loadFixture(deployContractsAndInitPermit);

                const deadline = (await time.latest()) - time.duration.weeks(1);
                const permit = await getPermit(addr.address, addr1, weth, '1', chainId, swap.address, '1', deadline);

                const { r, vs } = compactSignature(signature);
                await expect(swap.fillOrderToWithPermit(order, r, vs, 1, 1, addr.address, '0x', permit))
                    .to.be.revertedWith('ERC20Permit: expired deadline');
            });
        });

        describe('maker permit', function () {
            const deployContractsAndInitPermit = async function () {
                const { dai, weth, swap, chainId } = await deploySwapTokens();
                await initContracts(dai, weth, swap);

                const permit = withTarget(
                    weth.address,
                    await getPermit(addr.address, addr, weth, '1', chainId, swap.address, '1'),
                );

                const order = buildOrder(
                    {
                        makerAsset: weth.address,
                        takerAsset: dai.address,
                        makingAmount: 1,
                        takingAmount: 1,
                        maker: addr.address,
                    },
                    {
                        permit,
                    },
                );

                const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr));
                return { dai, weth, swap, order, r, vs, permit };
            };

            it('maker permit works', async function () {
                const { dai, weth, swap, order, r, vs } = await loadFixture(deployContractsAndInitPermit);

                await expect(swap.connect(addr1).fillOrderExt(order, r, vs, 1, fillWithMakingAmount(1), order.extension))
                    .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                    .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
            });

            it('skips order permit flag', async function () {
                const { dai, weth, swap, order, r, vs, permit } = await loadFixture(deployContractsAndInitPermit);

                await addr1.sendTransaction({ to: weth.address, data: '0xd505accf' + permit.substring(42) });
                await expect(swap.connect(addr1).fillOrderExt(order, r, vs, 1, skipMakerPermit(0), order.extension))
                    .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                    .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
            });
        });
    });

    describe('Amount Calculator', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId };
        };

        it('empty takingAmountGetter should work on full fill', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                maker: addr1.address,
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 10,
                makerTraits: buildMakerTraits({ allowPartialFill: false }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 10, fillWithMakingAmount(10)))
                .to.changeTokenBalances(dai, [addr, addr1], [10, -10])
                .to.changeTokenBalances(weth, [addr, addr1], [-10, 10]);
        });

        it('empty takingAmountGetter should revert on partial fill', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                maker: addr1.address,
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 10,
                makerTraits: buildMakerTraits({ allowPartialFill: false }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 5, fillWithMakingAmount(5)))
                .to.be.revertedWithCustomError(swap, 'PartialFillNotAllowed');
        });

        it('empty makingAmountGetter should revert on partial fill', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                maker: addr1.address,
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 10,
                makerTraits: buildMakerTraits({ allowPartialFill: false }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 5, 5))
                .to.be.revertedWithCustomError(swap, 'PartialFillNotAllowed');
        });

        it('empty makingAmountGetter should work on full fill', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                maker: addr1.address,
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 10,
                takingAmount: 10,
                makerTraits: buildMakerTraits({ allowPartialFill: false }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 10, 10))
                .to.changeTokenBalances(dai, [addr, addr1], [10, -10])
                .to.changeTokenBalances(weth, [addr, addr1], [-10, 10]);
        });
    });

    describe('ETH Maker Orders', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            const ETHOrders = await ethers.getContractFactory('ETHOrders');
            const ethOrders = await ETHOrders.deploy(weth.address, swap.address);
            await ethOrders.deployed();
            return { dai, weth, swap, chainId, ethOrders };
        };

        it('Partial fill', async function () {
            const { dai, weth, swap, chainId, ethOrders } = await loadFixture(deployContractsAndInit);

            const order = buildOrder(
                {
                    maker: ethOrders.address,
                    makerAsset: weth.address,
                    takerAsset: dai.address,
                    makingAmount: ether('0.3'),
                    takingAmount: ether('300'),
                },
                {
                    receiver: addr1.address,
                    postInteraction: ethOrders.address,
                },
            );
            const orderHash = await swap.hashOrder(order);

            await expect(ethOrders.connect(addr1).ethOrderDeposit(order, order.extension, { value: ether('0.3') }))
                .to.changeEtherBalance(addr1, ether('-0.3'))
                .to.changeTokenBalance(weth, ethOrders, ether('0.3'));

            let orderMakerBalance = await ethOrders.ordersMakersBalances(orderHash);
            expect(orderMakerBalance.balance).to.equal(ether('0.3'));
            expect(orderMakerBalance.maker).to.equal(addr1.address);

            const ethOrdersBatch = await ethOrders.ethOrdersBatch([orderHash]);
            expect(ethOrdersBatch[0].balance).to.equal(ether('0.3'));
            expect(ethOrdersBatch[0].maker).to.equal(addr1.address);

            const signature = await signOrder(order, chainId, swap.address, addr1);

            /// Partial fill
            await expect(swap.fillContractOrderExt(order, signature, ether('200'), ether('0.2'), addr.address, '0x', '0x', order.extension))
                .to.changeTokenBalances(dai, [addr, ethOrders, addr1], [ether('-200'), '0', ether('200')])
                .to.changeTokenBalances(weth, [addr, ethOrders, addr1], [ether('0.2'), ether('-0.2'), '0']);

            /// Remaining fill
            await expect(swap.fillContractOrderExt(order, signature, ether('100'), ether('0.1'), addr.address, '0x', '0x', order.extension))
                .to.changeTokenBalances(dai, [addr, ethOrders, addr1], [ether('-100'), '0', ether('100')])
                .to.changeTokenBalances(weth, [addr, ethOrders, addr1], [ether('0.1'), ether('-0.1'), '0']);

            orderMakerBalance = await ethOrders.ordersMakersBalances(orderHash);
            expect(orderMakerBalance.balance).to.equal(0);
            expect(orderMakerBalance.maker).to.equal(addr1.address);
        });

        it('Partial fill -> cancel -> refund maker -> fail to fill', async function () {
            const { dai, weth, swap, chainId, ethOrders } = await loadFixture(deployContractsAndInit);
            const order = buildOrder(
                {
                    maker: ethOrders.address,
                    makerAsset: weth.address,
                    takerAsset: dai.address,
                    makingAmount: ether('0.3'),
                    takingAmount: ether('300'),
                },
                {
                    receiver: addr1.address,
                    postInteraction: ethOrders.address,
                },
            );
            const orderHash = await swap.hashOrder(order);

            await expect(ethOrders.connect(addr1).ethOrderDeposit(order, order.extension, { value: ether('0.3') }))
                .to.changeEtherBalance(addr1, ether('-0.3'))
                .to.changeTokenBalance(weth, ethOrders, ether('0.3'));

            const signature = await signOrder(order, chainId, swap.address, addr1);

            /// Partial fill
            await expect(swap.fillContractOrderExt(order, signature, ether('200'), ether('0.2'), addr.address, '0x', '0x', order.extension))
                .to.changeTokenBalances(dai, [addr, ethOrders, addr1], [ether('-200'), '0', ether('200')])
                .to.changeTokenBalances(weth, [addr, ethOrders, addr1], [ether('0.2'), ether('-0.2'), '0']);

            /// Cancel order
            await expect(ethOrders.connect(addr1).cancelOrder(order.makerTraits, orderHash))
                .to.changeTokenBalance(weth, ethOrders, ether('-0.1'))
                .to.changeEtherBalance(addr1, ether('0.1'));

            /// Remaining fill failure
            await expect(swap.fillContractOrderExt(order, signature, ether('100'), ether('0.1'), addr.address, '0x', '0x', order.extension))
                .to.be.revertedWithCustomError(swap, 'InvalidatedOrder');
        });

        it('Invalid order (missing post-interaction)', async function () {
            const { dai, weth, ethOrders } = await loadFixture(deployContractsAndInit);

            const order = buildOrder(
                {
                    maker: ethOrders.address,
                    makerAsset: weth.address,
                    takerAsset: dai.address,
                    makingAmount: ether('0.3'),
                    takingAmount: ether('300'),
                },
                {
                    receiver: addr1.address,
                },
            );

            await expect(ethOrders.connect(addr1).ethOrderDeposit(order, order.extension, { value: ether('0.3') }))
                .to.be.revertedWithCustomError(ethOrders, 'InvalidOrder');
        });
    });

    describe('Order Cancelation', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId };
        };

        const orderCancelationInit = async function () {
            const { dai, weth, swap, chainId } = await deployContractsAndInit();
            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ allowMultipleFills: true }),
            });
            return { dai, weth, swap, chainId, order };
        };

        // TODO: it could be canceled with another makerTraits, 1n << ALLOW_MUTIPLE_FILLS_FLAG (254n) for example
        it('should cancel own order', async function () {
            const { swap, chainId, order } = await loadFixture(orderCancelationInit);
            const data = buildOrderData(chainId, swap.address, order);
            const orderHash = ethers.utils._TypedDataEncoder.hash(data.domain, data.types, data.value);
            await swap.connect(addr1).cancelOrder(order.makerTraits, orderHash);
            expect(await swap.remainingInvalidatorForOrder(addr1.address, orderHash)).to.equal('0');
        });

        it('should cancel any hash', async function () {
            const { swap, order } = await loadFixture(orderCancelationInit);
            await swap.connect(addr1).cancelOrder(order.makerTraits, '0x0000000000000000000000000000000000000000000000000000000000000001');
            expect(await swap.remainingInvalidatorForOrder(addr1.address, '0x0000000000000000000000000000000000000000000000000000000000000001')).to.equal('0');
        });

        it('should not fill cancelled order', async function () {
            const { swap, chainId, order } = await loadFixture(orderCancelationInit);
            const signature = await signOrder(order, chainId, swap.address, addr1);
            const { r, vs } = compactSignature(signature);
            const data = buildOrderData(chainId, swap.address, order);
            const orderHash = ethers.utils._TypedDataEncoder.hash(data.domain, data.types, data.value);

            await swap.connect(addr1).cancelOrder(order.makerTraits, orderHash);

            await expect(swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'InvalidatedOrder');
        });
    });

    describe('Private Orders', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId };
        };

        it('should fill with correct taker', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ allowedSender: addr.address }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)))
                .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });

        it('should not fill with incorrect taker', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ allowedSender: addr1.address }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'PrivateOrder');
        });
    });

    describe('Predicate', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId };
        };

        it.skip('`or` should pass', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const tsBelow = swap.interface.encodeFunctionData('timestampBelow', ['0xff0000']);
            const eqNonce = swap.interface.encodeFunctionData('epochEquals', [addr1.address, 0, 0]);
            const { offsets, data } = joinStaticCalls([tsBelow, eqNonce]);

            const order = buildOrder(
                {
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: 1,
                    takingAmount: 1,
                    maker: addr1.address,
                },
                {
                    predicate: swap.interface.encodeFunctionData('or', [offsets, data]),
                },
            );
            const signature = await signOrder(order, chainId, swap.address, addr1);
            const { r, vs } = compactSignature(signature);

            const makerDai = await dai.balanceOf(addr1.address);
            const takerDai = await dai.balanceOf(addr.address);
            const makerWeth = await weth.balanceOf(addr1.address);
            const takerWeth = await weth.balanceOf(addr.address);

            await expect(
                swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)),
            ).to.revertedWithCustomError(swap, 'MissingOrderExtension');

            await swap.fillOrderExt(order, r, vs, 1, fillWithMakingAmount(1), order.extension);

            expect(await dai.balanceOf(addr1.address)).to.equal(makerDai.sub(1));
            expect(await dai.balanceOf(addr.address)).to.equal(takerDai.add(1));
            expect(await weth.balanceOf(addr1.address)).to.equal(makerWeth.add(1));
            expect(await weth.balanceOf(addr.address)).to.equal(takerWeth.sub(1));
        });

        it('reverts on expiration constraint', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ expiry: 0xff0000n }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'OrderExpired');
        });

        it('`and` should pass', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ expiry: 0xff000000n }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, fillWithMakingAmount(1), 1))
                .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });

        it('nonce + ts example', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ expiry: 0xff000000n }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)))
                .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });

        it('advance nonce', async function () {
            const { swap } = await loadFixture(deployContractsAndInit);
            await swap.increaseEpoch(0);
            expect(await swap.epoch(addr.address, 0)).to.equal('1');
        });

        it.skip('`and` should fail', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const tsBelow = swap.interface.encodeFunctionData('timestampBelow', [0xff0000n]);
            const eqNonce = swap.interface.encodeFunctionData('epochEquals', [addr1.address, 0, 0]);
            const { offsets, data } = joinStaticCalls([tsBelow, eqNonce]);

            const order = buildOrder(
                {
                    makerAsset: dai.address,
                    takerAsset: weth.address,
                    makingAmount: 1,
                    takingAmount: 1,
                    maker: addr1.address,
                },
                {
                    predicate: swap.interface.encodeFunctionData('and', [offsets, data]),
                },
            );

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrderExt(order, r, vs, 1, fillWithMakingAmount(1), order.extension))
                .to.be.revertedWithCustomError(swap, 'PredicateIsNotTrue');
        });
    });

    describe('Expiration', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId };
        };

        it('should fill when not expired', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, fillWithMakingAmount(1), 1))
                .to.changeTokenBalances(dai, [addr, addr1], [1, -1])
                .to.changeTokenBalances(weth, [addr, addr1], [-1, 1]);
        });

        it('should not fill when expired', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 1,
                takingAmount: 1,
                maker: addr1.address,
                makerTraits: buildMakerTraits({ expiry: 0xff0000n }),
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 1, fillWithMakingAmount(1)))
                .to.be.revertedWithCustomError(swap, 'OrderExpired');
        });

        it('should fill partially if not enough coins (taker)', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 2,
                takingAmount: 2,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 3, 2))
                .to.changeTokenBalances(dai, [addr, addr1], [2, -2])
                .to.changeTokenBalances(weth, [addr, addr1], [-2, 2]);
        });

        it('should fill partially if not enough coins (maker)', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 2,
                takingAmount: 2,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 3, fillWithMakingAmount(3)))
                .to.changeTokenBalances(dai, [addr, addr1], [2, -2])
                .to.changeTokenBalances(weth, [addr, addr1], [-2, 2]);
        });
    });

    describe('ETH fill', function () {
        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId, usdc } = await deploySwapTokens();
            await initContracts(dai, weth, swap);
            return { dai, weth, swap, chainId, usdc };
        };

        it('should fill with ETH', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 900,
                takingAmount: 3,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 900, fillWithMakingAmount(3), { value: 3 }))
                .to.changeTokenBalances(dai, [addr, addr1], [900, -900])
                .to.changeTokenBalances(weth, [addr, addr1], [0, 3])
                .to.changeEtherBalance(addr, -3);
        });

        it('should revert with takerAsset WETH and not enough msg.value', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 900,
                takingAmount: 3,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 900, fillWithMakingAmount(3), { value: 2 }))
                .to.be.revertedWithCustomError(swap, 'InvalidMsgValue');
        });

        it('should pass with takerAsset WETH and correct msg.value', async function () {
            const { dai, weth, swap, chainId } = await loadFixture(deployContractsAndInit);

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: weth.address,
                makingAmount: 900,
                takingAmount: 3,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 900, fillWithMakingAmount(3), { value: 4 }))
                .to.changeTokenBalances(dai, [addr, addr1], [900, -900])
                .to.changeTokenBalances(weth, [addr, addr1], [0, 3])
                .to.changeEtherBalance(addr, -3);
        });

        it('should reverted with takerAsset non-WETH and msg.value greater than 0', async function () {
            const { dai, swap, chainId, usdc } = await loadFixture(deployContractsAndInit);

            await usdc.mint(addr.address, '1000000');
            await usdc.approve(swap.address, '1000000');

            const order = buildOrder({
                makerAsset: dai.address,
                takerAsset: usdc.address,
                makingAmount: 900,
                takingAmount: 900,
                maker: addr1.address,
            });

            const { r, vs } = compactSignature(await signOrder(order, chainId, swap.address, addr1));
            await expect(swap.fillOrder(order, r, vs, 900, fillWithMakingAmount(900), { value: 1 }))
                .to.be.revertedWithCustomError(swap, 'InvalidMsgValue');
        });
    });

    /**
     * Range limit order is used to sell an asset within a given price range.
     * For example, right now ETH is worth 3000 DAI and you believe that within the next week the price of ETH will rise and reach at least 4000 DAI.
     * In this case, you can create an ETH -> DAI limit order with a price range of 3000 -> 4000.
     * Let's say you created a similar order for the amount of 10 ETH.
     * Someone can file the entire limit at once at an average price of 3500 DAI.
     * But it is also possible that the limit-order will be filed in parts.
     * First, someone buys 1 ETH at the price of 3050 DAI, then another 1 ETH at the price of 3150 DAI, and so on.
     */
    describe('Range limit orders', function () {
        // TODO: extract to separate file, kill huge fillRangeLimitOrder, have small and self explaining tests
        let maker, taker;

        const e6 = (value) => ether(value).div(1000000000000n);

        before(async function () {
            maker = addr1.address;
            taker = addr.address;
        });

        const deployContractsAndInit = async function () {
            const { dai, weth, swap, chainId } = await deploySwapTokens();
            await initContracts(dai, weth, swap);

            const TokenCustomDecimalsMock = await ethers.getContractFactory('TokenCustomDecimalsMock');
            const usdc = await TokenCustomDecimalsMock.deploy('USDC', 'USDC', '0', 6);
            await usdc.deployed();
            await usdc.mint(maker, e6('1000000000000'));
            await usdc.mint(taker, e6('1000000000000'));
            await usdc.approve(swap.address, e6('1000000000000'));
            await usdc.connect(addr1).approve(swap.address, e6('1000000000000'));

            const RangeAmountCalculator = await ethers.getContractFactory('RangeAmountCalculator');
            const rangeAmountCalculator = await RangeAmountCalculator.deploy();
            await rangeAmountCalculator.deployed();

            return { dai, weth, swap, chainId, usdc, rangeAmountCalculator };
        };

        /**
         * @param makerAsset assetObject
         * @param takerAsset assetObject
         * @param fillOrderParams array of objects with params for fillOrder methods
         * @param isByMakerAsset flag shows to fill range order by maker asset
         *
         * assetObject = {
         *      asset: IERC20
         *      ether: function(amount) => amount * assetDecimals
         * }
         *
         * fillOrderParams = [{
         *      makingAmount: uint256
         *      takingAmount: uint256
         *      thresholdAmount: uint256
         * }]
         */
        async function fillRangeLimitOrder (makerAsset, takerAsset, fillOrderParams, isByMakerAsset, swap, rangeAmountCalculator, chainId) {
            const getRangeAmount = (isByMakerAsset ? rangeAmountCalculator.getRangeTakerAmount : rangeAmountCalculator.getRangeMakerAmount);

            // Order: 10 MA -> 35000 TA with price range: 3000 -> 4000 TA
            const makingAmount = makerAsset.ether('10');
            const takingAmount = takerAsset.ether('35000');
            const startPrice = takerAsset.ether('3000');
            const endPrice = takerAsset.ether('4000');
            const order = buildOrder(
                {
                    makerAsset: makerAsset.asset.address,
                    takerAsset: takerAsset.asset.address,
                    makingAmount,
                    takingAmount,
                    maker,
                    makerTraits: buildMakerTraits({ allowMultipleFills: true }),
                },
                {
                    makingAmountGetter: rangeAmountCalculator.address + trim0x(cutLastArg(cutLastArg(
                        rangeAmountCalculator.interface.encodeFunctionData('getRangeMakerAmount', [startPrice, endPrice, makingAmount, 0, 0],
                            64,
                        )))),
                    takingAmountGetter: rangeAmountCalculator.address + trim0x(cutLastArg(cutLastArg(
                        rangeAmountCalculator.interface.encodeFunctionData('getRangeTakerAmount', [startPrice, endPrice, makingAmount, 0, 0],
                            64,
                        )))),
                },
            );
            const signature = await signOrder(order, chainId, swap.address, addr1);
            const { r, vs } = compactSignature(signature);

            const makerTABalance = await takerAsset.asset.balanceOf(maker); // maker's takerAsset balance
            const takerTABalance = await takerAsset.asset.balanceOf(taker); // taker's takerAsset balance
            const makerMABalance = await makerAsset.asset.balanceOf(maker); // maker's makerAsset balance
            const takerMABalance = await makerAsset.asset.balanceOf(taker); // taker's makerAsset balance

            // Buy fillOrderParams[0].makingAmount tokens of makerAsset,
            // price should be fillOrderParams[0].takingAmount tokens of takerAsset
            await swap.fillOrderExt(
                order,
                r,
                vs,
                isByMakerAsset
                    ? makerAsset.ether(fillOrderParams[0].makingAmount)
                    : takerAsset.ether(fillOrderParams[0].takingAmount),
                isByMakerAsset
                    ? fillWithMakingAmount(takerAsset.ether(fillOrderParams[0].thresholdAmount))
                    : makerAsset.ether(fillOrderParams[0].thresholdAmount),
                order.extension,
            );

            const rangeAmount1 = await getRangeAmount(
                startPrice,
                endPrice,
                makingAmount,
                isByMakerAsset ? makerAsset.ether(fillOrderParams[0].makingAmount) : takerAsset.ether(fillOrderParams[0].takingAmount),
                makingAmount,
            );
            if (isByMakerAsset) {
                expect(await takerAsset.asset.balanceOf(maker)).to.equal(makerTABalance.add(rangeAmount1));
                expect(await makerAsset.asset.balanceOf(maker)).to.equal(makerMABalance.sub(makerAsset.ether(fillOrderParams[0].makingAmount)));
                expect(await takerAsset.asset.balanceOf(taker)).to.equal(takerTABalance.sub(rangeAmount1));
                expect(await makerAsset.asset.balanceOf(taker)).to.equal(takerMABalance.add(makerAsset.ether(fillOrderParams[0].makingAmount)));
            } else {
                expect(await takerAsset.asset.balanceOf(maker)).to.equal(makerTABalance.add(takerAsset.ether(fillOrderParams[0].takingAmount)));
                expect(await makerAsset.asset.balanceOf(maker)).to.equal(makerMABalance.sub(rangeAmount1));
                expect(await takerAsset.asset.balanceOf(taker)).to.equal(takerTABalance.sub(takerAsset.ether(fillOrderParams[0].takingAmount)));
                expect(await makerAsset.asset.balanceOf(taker)).to.equal(takerMABalance.add(rangeAmount1));
            }

            // Buy fillOrderParams[1].makingAmount tokens of makerAsset more,
            // price should be fillOrderParams[1].takingAmount tokens of takerAsset
            await swap.fillOrderExt(
                order,
                r,
                vs,
                isByMakerAsset
                    ? makerAsset.ether(fillOrderParams[1].makingAmount)
                    : takerAsset.ether(fillOrderParams[1].takingAmount),
                isByMakerAsset
                    ? fillWithMakingAmount(takerAsset.ether(fillOrderParams[1].thresholdAmount))
                    : makerAsset.ether(fillOrderParams[1].thresholdAmount),
                order.extension,
            );
            const rangeAmount2 = await getRangeAmount(
                startPrice,
                endPrice,
                makingAmount,
                isByMakerAsset ? makerAsset.ether(fillOrderParams[1].makingAmount) : takerAsset.ether(fillOrderParams[1].takingAmount),
                isByMakerAsset ? makingAmount.sub(makerAsset.ether(fillOrderParams[0].makingAmount)) : makingAmount.sub(rangeAmount1),
            );
            if (isByMakerAsset) {
                expect(await takerAsset.asset.balanceOf(maker)).to.equal(makerTABalance.add(rangeAmount1).add(rangeAmount2));
                expect(await makerAsset.asset.balanceOf(maker)).to.equal(
                    makerMABalance
                        .sub(makerAsset.ether(fillOrderParams[0].makingAmount))
                        .sub(makerAsset.ether(fillOrderParams[1].makingAmount)),
                );
                expect(await takerAsset.asset.balanceOf(taker)).to.equal(takerTABalance.sub(rangeAmount1).sub(rangeAmount2));
                expect(await makerAsset.asset.balanceOf(taker)).to.equal(
                    takerMABalance
                        .add(makerAsset.ether(fillOrderParams[0].makingAmount))
                        .add(makerAsset.ether(fillOrderParams[1].makingAmount)),
                );
            } else {
                expect(await takerAsset.asset.balanceOf(maker)).to.equal(
                    makerTABalance
                        .add(takerAsset.ether(fillOrderParams[0].takingAmount))
                        .add(takerAsset.ether(fillOrderParams[1].takingAmount)),
                );
                expect(await makerAsset.asset.balanceOf(maker)).to.equal(makerMABalance.sub(rangeAmount1).sub(rangeAmount2));
                expect(await takerAsset.asset.balanceOf(taker)).to.equal(
                    takerTABalance
                        .sub(takerAsset.ether(fillOrderParams[0].takingAmount))
                        .sub(takerAsset.ether(fillOrderParams[1].takingAmount)),
                );
                expect(await makerAsset.asset.balanceOf(taker)).to.equal(takerMABalance.add(rangeAmount1).add(rangeAmount2));
            }
        };

        it('Fill range limit-order by maker asset', async function () {
            const { dai, weth, swap, chainId, rangeAmountCalculator } = await loadFixture(deployContractsAndInit);
            await fillRangeLimitOrder(
                { asset: weth, ether },
                { asset: dai, ether },
                [
                    { makingAmount: '2', takingAmount: '0', thresholdAmount: '6200' },
                    { makingAmount: '2', takingAmount: '0', thresholdAmount: '6600' },
                ],
                true,
                swap,
                rangeAmountCalculator,
                chainId,
            );
        });

        it('Fill range limit-order by maker asset when taker asset has different decimals', async function () {
            const { usdc, weth, swap, chainId, rangeAmountCalculator } = await loadFixture(deployContractsAndInit);
            await fillRangeLimitOrder(
                { asset: weth, ether },
                { asset: usdc, ether: e6 },
                [
                    { makingAmount: '2', takingAmount: '0', thresholdAmount: '6200' },
                    { makingAmount: '2', takingAmount: '0', thresholdAmount: '6600' },
                ],
                true,
                swap,
                rangeAmountCalculator,
                chainId,
            );
        });

        it('Fill range limit-order by taker asset', async function () {
            const { dai, weth, swap, rangeAmountCalculator, chainId } = await loadFixture(deployContractsAndInit);
            await fillRangeLimitOrder(
                { asset: weth, ether },
                { asset: dai, ether },
                [
                    { makingAmount: '0', takingAmount: '6200', thresholdAmount: '2' },
                    { makingAmount: '0', takingAmount: '6600', thresholdAmount: '2' },
                ],
                false,
                swap,
                rangeAmountCalculator,
                chainId,
            );
        });

        it('Fill range limit-order by taker asset when taker asset has different decimals', async function () {
            const { usdc, weth, swap, rangeAmountCalculator, chainId } = await loadFixture(deployContractsAndInit);
            await fillRangeLimitOrder(
                { asset: weth, ether },
                { asset: usdc, ether: e6 },
                [
                    { makingAmount: '0', takingAmount: '6200', thresholdAmount: '2' },
                    { makingAmount: '0', takingAmount: '6600', thresholdAmount: '2' },
                ],
                false,
                swap,
                rangeAmountCalculator,
                chainId,
            );
        });
    });
});
