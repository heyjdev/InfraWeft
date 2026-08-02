export const MAX_AZURE_SUBNET_PREFIX = 29
const IPV4_SPACE_SIZE = 2 ** 32

export interface ParsedCidr {
  address: string
  network: number
  prefix: number
  size: number
  cidr: string
}

export interface SubnetRange extends ParsedCidr {
  netmask: string
  firstAddress: string
  lastAddress: string
  firstUsable: string
  lastUsable: string
  totalAddresses: number
  azureUsableAddresses: number
}

function parseIpv4(value: string): number {
  const octets = value.split('.')
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) {
    throw new Error('Enter a valid IPv4 address.')
  }

  const numbers = octets.map(Number)
  if (numbers.some((part) => part < 0 || part > 255)) {
    throw new Error('Enter a valid IPv4 address.')
  }

  return numbers.reduce((result, part) => result * 256 + part, 0)
}

export function formatIpv4(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= IPV4_SPACE_SIZE) {
    throw new Error('IPv4 value is outside the supported range.')
  }

  return [
    Math.floor(value / 2 ** 24) % 256,
    Math.floor(value / 2 ** 16) % 256,
    Math.floor(value / 2 ** 8) % 256,
    value % 256,
  ].join('.')
}

export function parseCanonicalCidr(input: string): ParsedCidr {
  if (input !== input.trim() || /\s/.test(input)) {
    throw new Error('CIDR values cannot contain whitespace.')
  }

  const match = input.match(/^([^/]+)\/(\d{1,2})$/)
  if (!match) throw new Error('Enter a CIDR such as 10.40.0.0/16.')

  const addressValue = parseIpv4(match[1])
  const prefix = Number(match[2])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > MAX_AZURE_SUBNET_PREFIX) {
    throw new Error(`Use a prefix from /0 through /${MAX_AZURE_SUBNET_PREFIX}; Azure IPv4 subnets cannot be smaller than /${MAX_AZURE_SUBNET_PREFIX}.`)
  }

  const size = 2 ** (32 - prefix)
  const network = Math.floor(addressValue / size) * size
  const address = formatIpv4(network)
  if (addressValue !== network || input !== `${address}/${prefix}`) {
    throw new Error(`Use the canonical network address ${address}/${prefix}.`)
  }

  return { address, network, prefix, size, cidr: `${address}/${prefix}` }
}

export function describeSubnet(input: string | ParsedCidr): SubnetRange {
  const parsed = typeof input === 'string' ? parseCanonicalCidr(input) : input
  const last = parsed.network + parsed.size - 1
  const netmaskValue = parsed.prefix === 0 ? 0 : IPV4_SPACE_SIZE - parsed.size
  const azureUsableAddresses = Math.max(parsed.size - 5, 0)

  return {
    ...parsed,
    netmask: formatIpv4(netmaskValue),
    firstAddress: parsed.address,
    lastAddress: formatIpv4(last),
    firstUsable: azureUsableAddresses ? formatIpv4(parsed.network + 4) : 'None',
    lastUsable: azureUsableAddresses ? formatIpv4(last - 1) : 'None',
    totalAddresses: parsed.size,
    azureUsableAddresses,
  }
}

function sortRanges(ranges: SubnetRange[]): SubnetRange[] {
  return [...ranges].sort((left, right) => left.network - right.network || left.prefix - right.prefix)
}

export function splitSubnet(ranges: SubnetRange[], cidr: string): SubnetRange[] {
  const index = ranges.findIndex((range) => range.cidr === cidr)
  if (index < 0) throw new Error(`Subnet ${cidr} is not present in this plan.`)

  const current = ranges[index]
  if (current.prefix >= MAX_AZURE_SUBNET_PREFIX) {
    throw new Error(`Azure IPv4 subnets cannot be split beyond /${MAX_AZURE_SUBNET_PREFIX}.`)
  }

  const childPrefix = current.prefix + 1
  const childSize = current.size / 2
  const children = [
    describeSubnet({ address: current.address, network: current.network, prefix: childPrefix, size: childSize, cidr: `${current.address}/${childPrefix}` }),
    describeSubnet({ address: formatIpv4(current.network + childSize), network: current.network + childSize, prefix: childPrefix, size: childSize, cidr: `${formatIpv4(current.network + childSize)}/${childPrefix}` }),
  ]

  return sortRanges([...ranges.slice(0, index), ...children, ...ranges.slice(index + 1)])
}

export function siblingCidr(ranges: SubnetRange[], cidr: string): string | null {
  const current = ranges.find((range) => range.cidr === cidr)
  if (!current || current.prefix === 0) return null
  const parentSize = current.size * 2
  const parentNetwork = Math.floor(current.network / parentSize) * parentSize
  const siblingNetwork = current.network === parentNetwork ? parentNetwork + current.size : parentNetwork
  const sibling = ranges.find((range) => range.network === siblingNetwork && range.prefix === current.prefix)
  return sibling?.cidr ?? null
}

export function joinSubnet(ranges: SubnetRange[], cidr: string): SubnetRange[] {
  const current = ranges.find((range) => range.cidr === cidr)
  if (!current) throw new Error(`Subnet ${cidr} is not present in this plan.`)

  const sibling = siblingCidr(ranges, cidr)
  if (!sibling) throw new Error(`Subnet ${cidr} does not have a complete sibling leaf to join.`)

  const parentPrefix = current.prefix - 1
  const parentSize = current.size * 2
  const parentNetwork = Math.floor(current.network / parentSize) * parentSize
  const parentAddress = formatIpv4(parentNetwork)
  const parent = describeSubnet({
    address: parentAddress,
    network: parentNetwork,
    prefix: parentPrefix,
    size: parentSize,
    cidr: `${parentAddress}/${parentPrefix}`,
  })

  return sortRanges([
    ...ranges.filter((range) => range.cidr !== cidr && range.cidr !== sibling),
    parent,
  ])
}
