import { describe, expect, it } from 'vitest'
import {
  describeSubnet,
  joinSubnet,
  parseCanonicalCidr,
  splitSubnet,
  type SubnetRange,
} from './subnetCalculator'

const cidrs = (ranges: SubnetRange[]) => ranges.map((range) => range.cidr)

describe('visual subnet calculator', () => {
  it('describes IPv4 and Azure-reserved address ranges', () => {
    expect(describeSubnet('10.40.8.0/24')).toMatchObject({
      cidr: '10.40.8.0/24',
      netmask: '255.255.255.0',
      firstAddress: '10.40.8.0',
      lastAddress: '10.40.8.255',
      firstUsable: '10.40.8.4',
      lastUsable: '10.40.8.254',
      totalAddresses: 256,
      azureUsableAddresses: 251,
    })
  })

  it('requires canonical IPv4 CIDRs no smaller than an Azure /29 subnet', () => {
    expect(() => parseCanonicalCidr('10.40.8.1/24')).toThrow(/canonical/i)
    expect(() => parseCanonicalCidr('010.0.0.0/8')).toThrow('canonical network address 10.0.0.0/8')
    expect(() => parseCanonicalCidr('10.40.8.0/30')).toThrow(/\/29/i)
    expect(() => parseCanonicalCidr('10.40.8.0 /24')).toThrow(/whitespace/i)
    expect(() => parseCanonicalCidr('300.40.8.0/24')).toThrow(/IPv4/i)
  })

  it('splits a range into two ordered equal children', () => {
    const root = [describeSubnet('10.40.8.0/24')]
    expect(cidrs(splitSubnet(root, '10.40.8.0/24'))).toEqual([
      '10.40.8.0/25',
      '10.40.8.128/25',
    ])
  })

  it('supports independent repeated splits without disturbing adjacent ranges', () => {
    const first = splitSubnet([describeSubnet('10.40.8.0/24')], '10.40.8.0/24')
    expect(cidrs(splitSubnet(first, '10.40.8.0/25'))).toEqual([
      '10.40.8.0/26',
      '10.40.8.64/26',
      '10.40.8.128/25',
    ])
  })

  it('joins only complete sibling ranges and can reconstruct the root', () => {
    const split = splitSubnet(
      splitSubnet([describeSubnet('10.40.8.0/24')], '10.40.8.0/24'),
      '10.40.8.0/25',
    )
    const firstJoin = joinSubnet(split, '10.40.8.0/26')
    expect(cidrs(firstJoin)).toEqual(['10.40.8.0/25', '10.40.8.128/25'])
    expect(cidrs(joinSubnet(firstJoin, '10.40.8.128/25'))).toEqual(['10.40.8.0/24'])
  })

  it('refuses to join a range whose sibling is not currently a leaf', () => {
    const split = splitSubnet(
      splitSubnet([describeSubnet('10.40.8.0/24')], '10.40.8.0/24'),
      '10.40.8.0/25',
    )
    expect(() => joinSubnet(split, '10.40.8.128/25')).toThrow(/sibling/i)
  })
})
