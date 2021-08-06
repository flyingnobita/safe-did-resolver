import type {
  DIDResolutionResult,
  DIDResolutionOptions,
  DIDDocument,
  ParsedDID,
  Resolver,
  ResolverRegistry,
  VerificationMethod,
} from 'did-resolver'
import type { CeramicApi } from '@ceramicnetwork/common'
import { Caip10Link } from '@ceramicnetwork/stream-caip10-link'
import { ChainID, AccountID } from 'caip'
import { DIDDocumentMetadata } from 'did-resolver'
import { blockAtTime, erc1155OwnersOf, erc721OwnerOf, isWithinLastBlock } from './subgraph-utils'

const DID_LD_JSON = 'application/did+ld+json'
const DID_JSON = 'application/did+json'

// TODO - should be part of the caip library
export interface AssetID {
  chainId: ChainID
  namespace: string
  reference: string
  tokenId: string
}

function idToAsset(id: string): AssetID {
  // TODO use caip package to do this once it supports assetIds
  const [chainid, assetType, tokenId] = id.split('_')
  if (!(chainid && assetType && tokenId)) {
    throw new Error(`Invalid asset id: ${id}`)
  }
  const [namespace, reference] = assetType.split('.')
  if (!(namespace && reference)) {
    throw new Error(`Invalid asset id: ${id}`)
  }

  const hexTokenId = tokenId.startsWith('0x') ? tokenId : `0x${Number(tokenId).toString(16)}`

  return {
    chainId: new ChainID(ChainID.parse(chainid.replace('.', ':'))),
    namespace,
    reference,
    tokenId: hexTokenId,
  }
}

async function assetToAccount(
  asset: AssetID,
  timestamp: number | undefined,
  chains: Record<string, ChainConfig | undefined>
): Promise<AccountID[]> {
  const assetChainId = asset.chainId.toString()
  const chain = chains[assetChainId]
  if (!chain) {
    throw new Error(`No chain configuration for ${assetChainId}`)
  }

  // we want to query what block is at the timestamp IFF it is an (older) existing timestamp
  let queryBlock = 0
  if (timestamp && !isWithinLastBlock(timestamp)) {
    queryBlock = await blockAtTime(timestamp, chain.blocks)
  }

  let owners: string[]
  let ercSubgraphUrls = undefined

  if (chains && chains[assetChainId]) {
    ercSubgraphUrls = chains[assetChainId].assets
  }

  if (asset.namespace === 'erc721') {
    owners = [await erc721OwnerOf(asset, queryBlock, ercSubgraphUrls?.erc721)]
  } else if (asset.namespace === 'erc1155') {
    owners = await erc1155OwnersOf(asset, queryBlock, ercSubgraphUrls?.erc1155)
  } else {
    throw new Error(
      `Only erc721 and erc1155 namespaces are currently supported. Given: ${asset.namespace}`
    )
  }

  return owners.slice().map(
    (owner) =>
      new AccountID({
        chainId: asset.chainId,
        address: owner,
      })
  )
}

/**
 * Creates CAIP-10 links for each account to be used as controllers.
 * Since there may be many owners for a given NFT (only ERC1155 for now),
 * there can be many controllers of that DID document.
 */
async function accountsToDids(
  accounts: AccountID[],
  timestamp: number,
  ceramic: CeramicApi
): Promise<string[] | undefined> {
  const controllers: string[] = []

  const links = await Promise.all(
    accounts.map((accountId: AccountID) => Caip10Link.fromAccount(ceramic, accountId))
  )

  for (const link of links) {
    if (link?.did) controllers.push(link.did)
  }

  return controllers.length > 0 ? controllers : undefined
}

function wrapDocument(did: string, accounts: AccountID[], controllers?: string[]): DIDDocument {
  // Each of the owning accounts is a verification method (at the point in time)
  const verificationMethods = accounts.slice().map((account) => {
    return {
      id: `${did}#${account.address}`,
      type: 'BlockchainVerificationMethod2021',
      controller: did,
      blockchainAccountId: account.toString(),
    } as VerificationMethod
  })

  const doc: DIDDocument = {
    id: did,
    verificationMethod: [...verificationMethods],
  }

  // Controllers should only be an array when there're more than one
  if (controllers) doc.controller = controllers.length === 1 ? controllers[0] : controllers

  return doc
}

/**
 * Gets the unix timestamp from the `versionTime` parameter.
 * @param query
 */
function getVersionTime(query = ''): number {
  const versionTime = query.split('&').find((e) => e.includes('versionTime'))
  if (versionTime) {
    return Math.floor(new Date(versionTime.split('=')[1]).getTime() / 1000)
  }
  return 0 // 0 is falsey
}

function validateResolverConfig(config: NftResolverConfig) {
  if (!config) {
    throw new Error(`Missing nft-did-resolver config`)
  }
  if (!config.ceramic) {
    throw new Error('Missing ceramic client in nft-did-resolver config')
  }
  const chains = config.chains
  if (!chains) {
    throw new Error('Missing chain parameters in nft-did-resolver config')
  }
  try {
    Object.entries(config.chains).forEach(([chainId, chainConfig]) => {
      ChainID.parse(chainId)
      new URL(chainConfig.blocks)
      Object.values(chainConfig.assets).forEach((subgraph) => {
        new URL(subgraph)
      })
    })
  } catch (e) {
    throw new Error(`Invalid config for nft-did-resolver: ${e.message}`)
  }
}

export type ChainConfig = {
  blocks: string
  skew: number
  assets: Record<string, string>
}

/**
 * When passing in a custom subgraph url, it must conform to the same standards as
 * represented by the included ERC721 and ERC1155 subgraphs
 * Example:
 * ```
 * const customConfig = {
 *  ceramic: ceramicClient,
 *  chains: {
 *    "eip155:1": {
 *      "blocks": "https://api.thegraph.com/subgraphs/name/yyong1010/ethereumblocks",
 *      "skew": 15000, // in milliseconds
 *      "assets": {
 *        "erc1155": "https://api.thegraph.com/subgraphs/name/amxx/eip1155-subgraph",
 *        "erc721": "https://api.thegraph.com/subgraphs/name/touchain/erc721track",
 *      }
 *    }
 *  }
 * }
 * ```
 */
export type NftResolverConfig = {
  ceramic: CeramicApi
  chains: Record<string, ChainConfig>
}

async function resolve(
  did: string,
  methodId: string,
  timestamp: number,
  config: NftResolverConfig
): Promise<DIDResolutionResult> {
  const asset = idToAsset(methodId)
  // for 1155s, there can be many accounts that own a single asset
  const owningAccounts = await assetToAccount(asset, timestamp, config.chains)
  const controllers = await accountsToDids(owningAccounts, timestamp, config.ceramic)
  const metadata: DIDDocumentMetadata = {}

  // TODO create (if it stays in the spec)

  return {
    didResolutionMetadata: { contentType: DID_JSON },
    didDocument: wrapDocument(did, owningAccounts, controllers),
    didDocumentMetadata: metadata,
  } as DIDResolutionResult
}

export default {
  getResolver: (config: NftResolverConfig): ResolverRegistry => {
    validateResolverConfig(config)
    return {
      nft: async (
        did: string,
        parsed: ParsedDID,
        resolver: Resolver,
        options: DIDResolutionOptions
      ): Promise<DIDResolutionResult> => {
        const contentType = options.accept || DID_JSON
        try {
          const timestamp = getVersionTime(parsed.query)
          const didResult = await resolve(did, parsed.id, timestamp, config)

          if (contentType === DID_LD_JSON) {
            didResult.didDocument['@context'] = 'https://w3id.org/did/v1'
            didResult.didResolutionMetadata.contentType = DID_LD_JSON
          } else if (contentType !== DID_JSON) {
            didResult.didDocument = null
            didResult.didDocumentMetadata = {}
            delete didResult.didResolutionMetadata.contentType
            didResult.didResolutionMetadata.error = 'representationNotSupported'
          }
          return didResult
        } catch (e) {
          return {
            didResolutionMetadata: {
              error: 'invalidDid',
              message: e.toString(),
            },
            didDocument: null,
            didDocumentMetadata: {},
          }
        }
      },
    }
  },
}
