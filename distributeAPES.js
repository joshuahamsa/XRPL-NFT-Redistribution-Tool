const xrpl = require("xrpl");

async function getNFTsByIssuer(issuer, taxon, limit = 500) {
  try {
    // Connect to Clio node
    const client = new xrpl.Client("wss://s2-clio.ripple.com");
    await client.connect();

    console.log(`Querying NFTs for issuer: ${issuer} with taxon: ${taxon}`);

    let nfts = [];
    let marker = null;
    let batchCount = 0;

    do {
      batchCount++;
      const request = {
        method: "nfts_by_issuer",
        issuer: issuer,
        limit: limit,
        nft_taxon: taxon,
      };

      if (marker) {
        request.marker = marker;
      }

      const response = await client.request(request);

      if (response.result.nfts && response.result.nfts.length > 0) {
        nfts = nfts.concat(response.result.nfts);
        console.log(
          `Batch ${batchCount}: Found ${response.result.nfts.length} NFTs (Total so far: ${nfts.length})`
        );
      }

      marker = response.result.marker;

      // Add a small delay to prevent rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (marker); // Continue until no marker is returned

    console.log(`\n=== Final Summary ===`);
    console.log(`Total batches processed: ${batchCount}`);
    console.log(`Total NFTs found: ${nfts.length}`);

    await client.disconnect();
    return nfts;
  } catch (error) {
    console.error("Error fetching NFTs:", error);
    throw error;
  }
}

const ISSUER_ADDRESS = "rEzbi191M5AjrucxXKZWbR5QeyfpbedBcV";
const TAXON = 1;
const ACCOUNTS_TO_REDISTRIBUTE_FROM = ["rESvnQrpWVho8kEiHEVKXMBoiUzdkYVtDL"];
const ACCOUNTS_INELIGIBLE_FOR_REDISTRIBUTION = ["r3idziPApkZBJmnGq2LtvP5Skrti9uDaCx"];

(async () => {
  try {
    console.time("NFT Query Duration");
    const nfts = await getNFTsByIssuer(ISSUER_ADDRESS, TAXON);
    console.timeEnd("NFT Query Duration");

    if (nfts.length > 0) {
      // Count NFTs per owner, excluding the specified accounts
      const ownershipCount = nfts.reduce((acc, nft) => {
        if (
          !nft.is_burned &&
          !ACCOUNTS_TO_REDISTRIBUTE_FROM.includes(nft.owner) &&
          !ACCOUNTS_INELIGIBLE_FOR_REDISTRIBUTION.includes(nft.owner)
        ) {
          acc[nft.owner] = (acc[nft.owner] || 0) + 1;
        }
        return acc;
      }, {});

      // Get NFTs in excluded accounts with detailed logging
      const excludedAccountNFTs = nfts.filter((nft) => {
        if (!nft.is_burned && ACCOUNTS_TO_REDISTRIBUTE_FROM.includes(nft.owner)) {
          // Add detailed logging for each NFT found in excluded accounts
          console.log(`Found NFT in excluded account:
                        NFT ID: ${nft.nft_id}
                        Owner: ${nft.owner}
                        Serial: ${nft.serial}
                        Taxon: ${nft.nft_taxon}
                        Issuer: ${nft.issuer}`);
          return true;
        }
        return false;
      });

      // Add detailed breakdown by excluded account
      ACCOUNTS_TO_REDISTRIBUTE_FROM.forEach((account) => {
        const nftsInAccount = excludedAccountNFTs.filter(
          (nft) => nft.owner === account
        );
        console.log(`\nNFTs in ${account}: ${nftsInAccount.length}`);
      });

      // Verify we have exactly 546 NFTs in excluded accounts
      if (excludedAccountNFTs.length !== 546) {
        console.error(`\nERROR: NFT Count Mismatch
                    Expected: 546 NFTs
                    Found: ${excludedAccountNFTs.length} NFTs
                    Difference: ${excludedAccountNFTs.length - 546} NFTs`);

        // Additional validation
        console.log("\nValidating NFT properties:");
        const byTaxon = excludedAccountNFTs.reduce((acc, nft) => {
          acc[nft.nft_taxon] = (acc[nft.nft_taxon] || 0) + 1;
          return acc;
        }, {});
        console.log("NFTs by Taxon:", byTaxon);
      }

      // Calculate total NFTs (excluding burned and excluded accounts)
      const totalActiveNFTs = Object.values(ownershipCount).reduce(
        (a, b) => a + b,
        0
      );

      // Shuffle the NFTs array using Fisher-Yates algorithm
      const shuffleArray = (array) => {
        for (let i = array.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
      };

      let remainingNFTs = shuffleArray([...excludedAccountNFTs]); // Create a shuffled copy

      // =========================
      // Modified Redistribution Logic
      // =========================

      // 1) Determine which owners are eligible (must hold more than 5 NFTs)
      const eligibleOwners = Object.entries(ownershipCount).filter(
        ([, count]) => count > 5
      );
      // Keep track of total holdings among eligible owners
      const totalEligibleNFTs = eligibleOwners.reduce(
        (sum, [, count]) => sum + count,
        0
      );

      // We'll store final distribution info in this map
      const redistributionMap = {};

      // 2) Everyone eligible gets at least 1 NFT:
      const baseAllocation = 1;
      const numEligibleOwners = eligibleOwners.length;
      const totalBaseAllocation = baseAllocation * numEligibleOwners;
      const REMAINING_TO_DISTRIBUTE = 546 - totalBaseAllocation;

      if (REMAINING_TO_DISTRIBUTE < 0) {
        console.error(
          `Error: Not enough NFTs (546) to give at least 1 to each of the ${numEligibleOwners} eligible holders.`
        );
      }

      // Initialize redistributionMap
      eligibleOwners.forEach(([owner, count]) => {
        redistributionMap[owner] = {
          currentCount: count,
          proportion: count / totalEligibleNFTs, // For second-pass distribution
          additionalNFTs: 0,
          newTotal: 0,
          assignedNFTDetails: [],
        };
      });

      // 3) Distribute the remainder proportionally
      if (REMAINING_TO_DISTRIBUTE > 0) {
        // Calculate how many each owner gets in this second pass
        eligibleOwners.forEach(([owner]) => {
          const details = redistributionMap[owner];
          const proportionalShare = Math.floor(
            REMAINING_TO_DISTRIBUTE * details.proportion
          );
          details.additionalNFTs = proportionalShare;
        });

        // 4) Handle leftover due to rounding
        const totalAllocated = eligibleOwners.reduce(
          (sum, [owner]) => sum + redistributionMap[owner].additionalNFTs,
          0
        );
        let leftover = REMAINING_TO_DISTRIBUTE - totalAllocated;

        // By default, let's award leftover NFTs to those with the highest current holdings
        if (leftover > 0) {
          // Sort descending by current holdings
          const sortedEligibleOwners = [...eligibleOwners].sort(
            (a, b) => b[1] - a[1] // b[1] is the count
          );

          // Give 1 NFT to each of the top owners until leftover is depleted
          for (let i = 0; i < leftover; i++) {
            const [owner] = sortedEligibleOwners[i];
            redistributionMap[owner].additionalNFTs += 1;
          }
        }
      }

      // 5) Now everyone has baseAllocation + additionalNFTs
      eligibleOwners.forEach(([owner]) => {
        const details = redistributionMap[owner];
        details.newTotal =
          details.currentCount + baseAllocation + details.additionalNFTs;

        // Actually splice from the shuffled array
        const numToAssign = baseAllocation + details.additionalNFTs;
        details.assignedNFTDetails = remainingNFTs.splice(0, numToAssign);
      });

      // 6) Validation check
      const totalRedistributed = Object.values(redistributionMap).reduce(
        (sum, details) => sum + details.assignedNFTDetails.length,
        0
      );
      if (totalRedistributed !== 546 && REMAINING_TO_DISTRIBUTE >= 0) {
        console.error(
          `Error: Redistribution mismatch. Distributed ${totalRedistributed} NFTs instead of 546`
        );
      }

      // Convert to array for sorting
      const ownershipArray = Object.entries(redistributionMap)
        .map(([owner, stats]) => ({
          owner,
          currentCount: stats.currentCount,
          proportion: stats.proportion,
          additionalNFTs: stats.additionalNFTs,
          newTotal: stats.newTotal,
          assignedNFTDetails: stats.assignedNFTDetails,
        }))
        .sort((a, b) => b.newTotal - a.newTotal);

      // Print summary statistics
      const burnedCount = nfts.filter((nft) => nft.is_burned).length;
      console.log(`\n=== Current Statistics ===`);
      console.log(`Total NFTs: ${nfts.length}`);
      console.log(`Burned NFTs: ${burnedCount}`);
      console.log(`Active NFTs: ${nfts.length - burnedCount}`);
      console.log(
        `NFTs in excluded accounts (${ACCOUNTS_TO_REDISTRIBUTE_FROM.join(", ")}): ${
          excludedAccountNFTs.length
        }`
      );
      console.log(
        `Unique Owners (excluding ${ACCOUNTS_TO_REDISTRIBUTE_FROM.join(", ")}): ${
          Object.entries(ownershipCount).length
        }`
      );
      console.log(
        `Eligible Owners (>5 NFTs): ${ownershipArray.length} (of ${
          Object.entries(ownershipCount).length
        })`
      );

      console.log(`\n=== Top 10 Holders After Redistribution ===`);
      ownershipArray.slice(0, 10).forEach((item, index) => {
        console.log(
          `${index + 1}. ${item.owner}:` +
            `\n   Current: ${item.currentCount} NFTs` +
            `\n   Additional: ${item.additionalNFTs} NFTs` +
            `\n   New Total: ${item.newTotal} NFTs` +
            `\n   Proportion: ${(item.proportion * 100).toFixed(2)}%` +
            `\n   Assigned NFT Count: ${item.assignedNFTDetails.length}`
        );
      });

      // Distribution summary after redistribution
      const newDistribution = {
        "1-10 NFTs": ownershipArray.filter(
          (x) => x.newTotal >= 1 && x.newTotal <= 10
        ).length,
        "11-50 NFTs": ownershipArray.filter(
          (x) => x.newTotal >= 11 && x.newTotal <= 50
        ).length,
        "51-100 NFTs": ownershipArray.filter(
          (x) => x.newTotal >= 51 && x.newTotal <= 100
        ).length,
        "101-200 NFTs": ownershipArray.filter(
          (x) => x.newTotal >= 101 && x.newTotal <= 200
        ).length,
        "200+ NFTs": ownershipArray.filter((x) => x.newTotal > 200).length,
      };

      console.log(`\n=== Distribution After Redistribution ===`);
      Object.entries(newDistribution).forEach(([range, count]) => {
        console.log(`${range}: ${count} owners`);
      });

      // Save detailed results
      const fs = require("fs");
      const results = {
        totalNFTs: nfts.length,
        burnedNFTs: burnedCount,
        excludedAccountNFTs: excludedAccountNFTs.length,
        uniqueOwners: Object.entries(ownershipCount).length,
        eligibleOwners: ownershipArray.length,
        redistributionDetails: ownershipArray.map((owner) => ({
          ...owner,
          assignedNFTDetails: owner.assignedNFTDetails.map((nft) => ({
            nft_id: nft.nft_id,
            uri: nft.uri,
            serial: nft.serial,
          })),
        })),
        distributionSummary: newDistribution,
        unassignedNFTs: excludedAccountNFTs.length, // Any remaining unassigned NFTs
      };

      fs.writeFileSync(
        "nft_redistribution_results.json",
        JSON.stringify(results, null, 2)
      );
      console.log(
        "\nDetailed results have been saved to nft_redistribution_results.json"
      );
    } else {
      console.log(`No NFTs found with taxon ${TAXON}`);
    }
  } catch (error) {
    console.error("Failed to run example:", error);
  }
})();
