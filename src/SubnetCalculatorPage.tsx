import { useMemo, useState } from 'react'
import { Calculator, Check, Clipboard, Combine, Network, RotateCcw, Scissors, ShieldCheck } from 'lucide-react'
import {
  MAX_AZURE_SUBNET_PREFIX,
  describeSubnet,
  joinSubnet,
  parseCanonicalCidr,
  siblingCidr,
  splitSubnet,
  type SubnetRange,
} from './subnetCalculator'
import './SubnetCalculator.css'

const DEFAULT_CIDR = '10.40.0.0/16'

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export default function SubnetCalculatorPage() {
  const [input, setInput] = useState(DEFAULT_CIDR)
  const [root, setRoot] = useState(() => describeSubnet(DEFAULT_CIDR))
  const [ranges, setRanges] = useState<SubnetRange[]>(() => [describeSubnet(DEFAULT_CIDR)])
  const [selectedCidr, setSelectedCidr] = useState(DEFAULT_CIDR)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const selected = ranges.find((range) => range.cidr === selectedCidr) ?? ranges[0]
  const allocated = useMemo(() => ranges.reduce((total, range) => total + range.azureUsableAddresses, 0), [ranges])

  function applyNetwork() {
    try {
      const parsed = parseCanonicalCidr(input)
      const nextRoot = describeSubnet(parsed)
      setRoot(nextRoot)
      setRanges([nextRoot])
      setSelectedCidr(nextRoot.cidr)
      setInput(nextRoot.cidr)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The network could not be parsed.')
    }
  }

  function reset() {
    setInput(root.cidr)
    setRanges([root])
    setSelectedCidr(root.cidr)
    setError('')
  }

  function divide(cidr: string) {
    try {
      const current = ranges.find((range) => range.cidr === cidr)
      const next = splitSubnet(ranges, cidr)
      setRanges(next)
      const firstChild = current && next.find((range) => range.network === current.network && range.prefix === current.prefix + 1)
      setSelectedCidr(firstChild?.cidr ?? next[0].cidr)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The subnet could not be divided.')
    }
  }

  function join(cidr: string) {
    try {
      const next = joinSubnet(ranges, cidr)
      setRanges(next)
      const joined = next.find((range) => range.network <= selected.network && range.network + range.size > selected.network)
      setSelectedCidr(joined?.cidr ?? next[0].cidr)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The subnet could not be joined.')
    }
  }

  async function copyPlan() {
    const text = ranges.map((range) => [
      range.cidr,
      `${range.firstAddress}–${range.lastAddress}`,
      `${range.firstUsable}–${range.lastUsable}`,
      `${range.azureUsableAddresses} Azure-usable`,
    ].join('\t')).join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return <div className="subnet-calculator-page">
    <header className="subnet-page-heading">
      <div className="subnet-title-icon"><Calculator size={22}/></div>
      <div>
        <span className="eyebrow">IP ADDRESS PLANNING</span>
        <h1>Visual subnet calculator</h1>
        <p>Split an IPv4 network into Azure-ready ranges, inspect reserved capacity, and join complete sibling ranges without doing binary arithmetic by hand.</p>
      </div>
      <div className="subnet-heading-actions">
        <button onClick={reset}><RotateCcw size={15}/> Reset plan</button>
        <button className="primary" onClick={copyPlan}>{copied ? <Check size={15}/> : <Clipboard size={15}/>} {copied ? 'Copied' : 'Copy ranges'}</button>
      </div>
    </header>

    <section className="subnet-input-card">
      <div className="subnet-input-copy">
        <strong>Parent network</strong>
        <span>Enter a canonical IPv4 CIDR. The planner stops at /{MAX_AZURE_SUBNET_PREFIX}, Azure's smallest supported IPv4 subnet.</span>
      </div>
      <label>
        <span>Network CIDR</span>
        <div className="subnet-input-row">
          <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && applyNetwork()} aria-invalid={Boolean(error)} placeholder="10.40.0.0/16"/>
          <button className="primary" onClick={applyNetwork}>Build plan</button>
        </div>
      </label>
      {error && <div className="subnet-error" role="alert">{error}</div>}
    </section>

    <section className="subnet-summary-grid">
      <article><span>Parent range</span><strong>{root.cidr}</strong><small>{root.firstAddress} – {root.lastAddress}</small></article>
      <article><span>Leaf subnets</span><strong>{ranges.length}</strong><small>{ranges.length === 1 ? 'Ready to divide' : 'Independently sized ranges'}</small></article>
      <article><span>Total addresses</span><strong>{formatCount(root.totalAddresses)}</strong><small>Includes Azure-reserved addresses</small></article>
      <article><span>Azure-usable</span><strong>{formatCount(allocated)}</strong><small>Five reserved addresses per subnet</small></article>
    </section>

    <section className="subnet-map-card">
      <div className="subnet-section-heading">
        <div><span className="eyebrow">RANGE MAP</span><h2>Address-space allocation</h2></div>
        <div className="subnet-map-legend"><span><i/> Selected range</span><span><i/> Azure reserved</span></div>
      </div>
      <div className="subnet-range-map" aria-label={`Visual allocation of ${root.cidr}`}>
        {ranges.map((range, index) => {
          const width = `${(range.totalAddresses / root.totalAddresses) * 100}%`
          return <button
            key={range.cidr}
            className={range.cidr === selected.cidr ? 'selected' : ''}
            style={{ flexBasis: width, '--range-index': index } as React.CSSProperties}
            onClick={() => setSelectedCidr(range.cidr)}
            title={`${range.cidr}: ${formatCount(range.azureUsableAddresses)} Azure-usable addresses`}
          >
            <span>{range.cidr}</span>
            <small>{formatCount(range.totalAddresses)} IPs</small>
          </button>
        })}
      </div>
      <div className="subnet-scale"><span>{root.firstAddress}</span><span>{root.lastAddress}</span></div>
    </section>

    <div className="subnet-detail-layout">
      <section className="subnet-table-card">
        <div className="subnet-section-heading">
          <div><span className="eyebrow">SUBNETS</span><h2>Planned ranges</h2></div>
          <span className="subnet-count-badge">{ranges.length} leaf {ranges.length === 1 ? 'range' : 'ranges'}</span>
        </div>
        <div className="subnet-table-wrap">
          <table>
            <thead><tr><th>Subnet</th><th>Address range</th><th>Azure-usable range</th><th>Capacity</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{ranges.map((range) => {
              const sibling = siblingCidr(ranges, range.cidr)
              return <tr key={range.cidr} className={range.cidr === selected.cidr ? 'selected' : ''} onClick={() => setSelectedCidr(range.cidr)}>
                <td><strong>{range.cidr}</strong><small>{range.netmask}</small></td>
                <td><span>{range.firstAddress}</span><small>{range.lastAddress}</small></td>
                <td><span>{range.firstUsable}</span><small>{range.lastUsable}</small></td>
                <td><strong>{formatCount(range.azureUsableAddresses)}</strong><small>{formatCount(range.totalAddresses)} total</small></td>
                <td><div className="subnet-row-actions">
                  <button disabled={range.prefix >= MAX_AZURE_SUBNET_PREFIX} onClick={(event) => { event.stopPropagation(); divide(range.cidr) }} title={`Divide ${range.cidr} into two /${range.prefix + 1} ranges`}><Scissors size={14}/> Split</button>
                  <button disabled={!sibling} onClick={(event) => { event.stopPropagation(); join(range.cidr) }} title={sibling ? `Join ${range.cidr} with ${sibling}` : 'A complete sibling leaf is required'}><Combine size={14}/> Join</button>
                </div></td>
              </tr>
            })}</tbody>
          </table>
        </div>
      </section>

      <aside className="subnet-inspector-card">
        <div className="subnet-inspector-title"><Network size={18}/><div><span className="eyebrow">SELECTED RANGE</span><h2>{selected.cidr}</h2></div></div>
        <dl>
          <div><dt>Netmask</dt><dd>{selected.netmask}</dd></div>
          <div><dt>Network address</dt><dd>{selected.firstAddress}</dd></div>
          <div><dt>Broadcast address</dt><dd>{selected.lastAddress}</dd></div>
          <div><dt>Total addresses</dt><dd>{formatCount(selected.totalAddresses)}</dd></div>
          <div><dt>Azure usable</dt><dd>{formatCount(selected.azureUsableAddresses)}</dd></div>
        </dl>
        <div className="azure-reservation-note"><ShieldCheck size={16}/><p><strong>Azure reserves five addresses</strong><span>The first four and final address of every subnet are unavailable to workloads.</span></p></div>
        <button className="subnet-primary-action" disabled={selected.prefix >= MAX_AZURE_SUBNET_PREFIX} onClick={() => divide(selected.cidr)}><Scissors size={15}/> Split into two /{selected.prefix + 1} ranges</button>
        <button disabled={!siblingCidr(ranges, selected.cidr)} onClick={() => join(selected.cidr)}><Combine size={15}/> Join sibling range</button>
      </aside>
    </div>
  </div>
}
