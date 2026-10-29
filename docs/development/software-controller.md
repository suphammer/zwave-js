# Software controller and radio backends

The software controller separates the host's Z-Wave protocol behavior from a
radio's firmware interface. The first radio implementation is Suphacap V2;
the controller code does not import the Suphacap adapter.

The current Driver integration uses an internal Serial API compatibility
layer so the existing controller and node APIs can use the software
controller. This layer does not open a TCP listener or require another
process.

## Responsibilities

| Layer               | Location                                        | Responsibility                                                                                                               |
| ------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Driver integration  | `lib/driver`                                    | Backend selection, lifecycle, and capability checks used by the existing controller APIs.                                    |
| Software controller | `lib/softcontroller`                            | Classic frame construction, inclusion and replication sequences, route selection, observed topology, and durable host state. |
| Radio contract      | `lib/softcontroller/SoftwareControllerRadio.ts` | Decoded receive events, region/channel information, MAC configuration, and completed transmit results.                       |
| Suphacap adapter    | `lib/suphacap`                                  | Physical serial connection, private RCP commands, firmware capability negotiation, and terminal callback validation.         |

The radio owns time-critical link acknowledgments, ACK matching, bounded
retries, and any negotiated wake-up beam operation. A backend must not
emulate these across USB through host timers. The software controller owns
the longer inclusion and replication sequences, using the radio's completed
MAC transactions.

Request Node Information waits up to five seconds on the selected transmit
channel. The radio holds RX there as part of the
transmit operation, so an immediate 9.6 kbit/s NIF cannot be lost to a retune.
The software controller restores normal reception before returning the
observed NIF to the Driver. Timeout, cancellation, reset, shutdown, and radio
errors trigger the same receiver cleanup; shutdown and fault cleanup disable MAC
instead of re-enabling normal traffic. Ordinary `send` results still report
transmit completion, independently of a later application response.

Capabilities describe implemented contracts. They do not follow from a
manufacturer name, a guessed SDK version, or a successfully queued command.
Unsupported SmartStart, Network Wide Inclusion, high-power overrides, and
transmit cancellation remain disabled for the initial software controller.
Missing node protocol information and unobserved links must not become
invented device capabilities or routes.

## Application response window

Ordinary acknowledged direct application traffic retains reception on its
transmit channel atomically when the radio finishes the MAC transaction. A
successful transmit starts a bounded 1000 ms idle response window; reports are
forwarded immediately and do not end it early. The transmit callback still
reports MAC completion, without waiting for or inventing an application reply.
A new transmit or MAC configuration supersedes the idle window without first
retuning away from that channel. At expiry, normal receive/hopping restoration
takes the existing transmit fence, so it cannot race a newer operation.
If a delayed report arrives during this bounded internal restoration, its next
application send or Request Node Information waits for that restoration and then rechecks controller
lifecycle, network-management, and transmit ownership. A genuine active transmit
still returns `NotIdle`; waiting does not bypass its fence. Restoration failure
fails the waiting command without transmitting.

The window follows the Driver's default base `timeouts.report` value of 1000 ms.
The Driver can wait longer after adding command RTT or applying per-message,
device-compatibility, or safe-mode overrides; this fixed receive window does not
follow those extensions. A 2026-10-29 lab capture showed a valid 9.6 kbit/s
Fibaro Meter Report about 322 ms after its ACK, beyond the former 250 ms receive
window. The one-second bound covers that measured delay; device response timing
still requires matching RF evidence after deployment.

Failed held transmissions restore reception before releasing the fence.
Management, reset, stop, and radio faults cancel stale deadlines; stop waits for
an already-running restoration, and fault/reset/shutdown cleanup disables MAC.
NOP, Protocol CC, routed and broadcast traffic retain their existing policy.
The separate atomic wake-up-beam contract does not support a held response
window, so a transmit requiring a beam is excluded. These software boundaries
do not qualify routed or FLiRS response timing in hardware.

## Direct transmit data-rate flag

For Classic channel configurations 1/2, direct transmissions below the known
shared maximum set Speed Modified, as specified by
[G.9959 §8.1.3.3.4](https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-G.9959-201501-I!!PDF-E&type=items).
Ordinary application DATA, Request Node Information, and NOP probes derive the
default from the retained NIF of an included destination on this controller's
Home ID. Missing NIF information does not imply a higher supported rate.

Commissioning and exclusion retain their explicit peer-capability overrides,
including an explicit false value when a foreign device shares a numeric node
ID with a local device. The flag is clear at the shared maximum and is not
applied to broadcast, routed, or configuration-3 frames. This changes neither
the selected PHY, payload, retry policy nor receive-window ownership. Correct
flag encoding alone does not prove receipt of an application response.

## Direct data-rate recovery

A previously confirmed lower transmit rate is a working fallback, rather than
a permanent speed limit. Before an ordinary ACK-requested public send, the
controller may probe strictly faster Classic profiles advertised in an included
peer's retained NIF. This requires an always-listening, non-FLiRS destination,
a stored transmit channel, and a direct path. Protocol CC, Security, Security 2,
Transport Service, broadcast, unknown peers, and internal node-information
requests do not initiate these probes.

The probes run under the caller's existing transmit fence, in descending data
rate order. Each uses a direct ACK-requested NOP with one radio-local attempt.
Distinct physical profiles remain separate even when their rates match; the
finite declared region table and backend transaction deadlines bound the work.
The current EU table has at most two faster profiles. A per-node 60-second
cooldown starts before the first probe, with no background recovery timer, and
is cleared when membership is removed, the controller is reset, or it stops.

Only a missing ACK permits another candidate. If every higher probe misses,
the original command is sent once at its existing rate. A successful NOP
confirms and persists the faster transmit preference; an original caller NOP
can reuse that result, while a real application command is sent once at the
confirmed rate with its normal retry and receive-window policy. Other probe
failures, radio faults, shutdown, and network reset abort the original send.
Application DATA is never repeated on another rate by this policy.
The existing missing-ACK fallback for a caller NOP also checks cancellation
before continuing onto another route or PHY.

Passive ACK, NIF, and application reception do not change the preferred transmit
channel. A received packet alone does not prove that a proposed transmit PHY
was acknowledged. Explorer discovery commits its actual transmit channel only
after terminal transmit success and a valid correlated Search Result; an early
result cannot publish preference while the local transmit is still unresolved.
These software guarantees require corresponding RF tests before claiming
device-specific rate recovery or application reliability.

## Node-information reception

An explicit node-information request first retains RX on its existing transmit
PHY for up to 250 ms, protecting long same-PHY NIFs. If no NIF arrives while the
request remains active, the controller repeats only the idempotent Protocol CC
`01 02` request on the same transmit PHY with normal receive hopping restored.
This lets a peer answer on another Classic PHY, including an awake battery
device whose NIF uses a different rate from its verified inclusion ACK.

Both phases share one response waiter, transmit fence, and original deadline of
at most five seconds. Cancellation, shutdown, reset, or radio fault prevents a
follow-up request, and receiver cleanup completes before the NIF reaches the
Driver. The operation sends at most two requests, adds no NOP or higher-rate TX
probe, and does not change the ACK-confirmed preferred transmit channel from
passive NIF reception or unacknowledged local transmit completion.

Valid unsolicited NIFs from included, assigned Classic nodes also become the
standard `ApplicationUpdate(NodeInfoReceived)` event. The upstream Driver then
updates the node's Command Classes, marks an awake battery node accordingly,
and resumes its queued interview. Only singlecast or broadcast NIFs are accepted;
foreign-Home, Explorer, multicast, routed-busy, own-node, and nonmember NIF
candidates are consumed without application callbacks. Truncated or otherwise
malformed NIFs are consumed too. No new device-class registry whitelist is used.

A NIF completes an outstanding node-information request only when its source
matches that request. Another included node's unsolicited update leaves the
pending request intact. Parsing and Serial API encoding finish before matching
request ownership is released, and an invalid bounded transport result cannot
leave a completed transport operation registered as pending. None of these
updates promotes the ACK-confirmed preferred transmit PHY from passive RX.

## End-node inclusion verification

After Assign IDs, an end node's new identity is verified with an acknowledged,
direct NOP. Verification first uses the preferred advertised Classic channel,
then the channel on which its learning NIF was actually received, followed by
remaining advertised Classic profiles available on the radio. A received NIF
is positive PHY evidence even when a legacy node omits that rate bit. Distinct
same-rate channels remain distinct; logical channel numbers do not imply a
frequency, data rate, or physical slot. Reduced verification rates set Speed
Modified from the received peer capabilities and the radio's shared maximum.

Only an idempotent NOP receives this fallback. Missing ACKs permit another
candidate; other transmit failures or cancellation stop verification. No
existing routes or numeric-node-ID metadata are borrowed. FLiRS verification
keeps its explicit atomic beam and uses only 40 kbit/s; controller replication
retains its separate transfer sequence. These policies do not qualify a new
device or PHY without corresponding RF evidence.

The first acknowledged candidate determines the persisted channel. Membership,
protocol information, and topology for the new node become visible to durable
snapshots together, after verification. Concurrent traffic from existing nodes
cannot persist an uncommitted node's NIF. If assignment may have succeeded but
verification fails, its ID remains quarantined and cannot be reused. Incoming
traffic alone does not promote a quarantined node. Recover a partly joined
device through ordinary exclusion and a new inclusion, rather than editing the
node mask or adding it synthetically.

## Classic exclusion

Direct exclusion accepts a learning NIF from a device in another network.
The NIF must be direct, contain a valid assigned Classic node ID, and not
request an ACK. The controller sends Assign IDs with zero Node ID and Home ID
on its own Home ID, as required by Network Specification NWK:01C8.1. The
transaction uses the received channel without borrowing an existing route or
wake-up configuration from a numerically matching local node.

Inclusion and exclusion send their corresponding Transfer Presentation
commands on the configured inclusion channel and hold reception there between
presentations. On Suphacap, local MAC `HOLD_RX` keeps a complete 9.6 kbit/s NIF
from being missed while hopping. Accepting a NIF cancels further presentations;
stop, reset, shutdown, and radio faults also cancel the presentation timer.
Startup and presentation failures restore normal reception, or disable MAC
when the radio is faulted or a controller reset is pending.

A successful exclusion from another network reports the Serial API's unknown
node ID zero. It does not remove a node from this controller's cache, change
its Home ID, or write its stored membership, routes, or channel information.
Own-network exclusions retain the actual node ID and persist the removal.
Completion requires the radio's acknowledged Assign IDs result; queuing a
transmission or observing an unrelated NIF is not exclusion evidence.

Assign IDs during inclusion and exclusion marks the Classic Speed Modified
header bit when its transmit rate is below the highest rate supported by both
the radio and the peer's received NIF. For example, a 9.6 kbit/s assignment to
a 40 kbit/s peer sets the bit. This follows
[G.9959 §8.1.3.3.4](https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-G.9959-201501-I!!PDF-E&type=items);
it does not change the selected rate or infer peer capabilities from an
unrelated local node with the same numeric ID. Broadcast and routed transmit
policy are unchanged.

Foreign exclusion does not use ordinary NOP verification on the controller's
network; see the [Silicon Labs protocol change notes](https://docs.silabs.com/z-wave/7.24.0/zwave-api/).
This direct path does not implement Network Wide Exclusion or high-power
overrides. Physical compatibility still requires validation with the device
and radio backend being used.

### Foreign-network ACK identity

The leaving device's previous Home ID is passed separately as an additional
accepted ACK identity, alongside the transmitted frame's Home ID. The
transmitted Assign IDs still uses the controller's
Home ID and a forced direct route, without borrowing local routes or beaming
state for a numerically matching node. The optional radio capability
`foreignHomeIdAcknowledgement` must be negotiated before this transmit; an
unsupported backend fails closed instead of ignoring the expected ACK Home ID.
This option never fabricates an ACK or changes the success criteria.

Suphacap implements this contract with separately negotiated MAC capability
`0x40` and private transmit flag `0x08`. It temporarily configures the additional
ACK Home ID with automatic ACK disabled, leaves the MPDU's Home ID unchanged,
and restores the previous configuration after the transaction. Fault cleanup
keeps MAC disabled. The normal operational minimum remains `0x33`; firmware
without `0x40` can still perform own-network exclusion, while foreign exclusion
fails before transmission.

## Controller identity and firmware

The optional `SoftwareControllerRadio.firmwareInfo` metadata passes through the
shared backend to `Driver.controllerFirmwareInfo`. It contains only strings and
is returned as a detached snapshot. Discovery and shutdown determine its
availability; it is not stored in the network database or inferred from a cached
controller node. Radio implementations without metadata remain supported.

Suphacap reports the local display manufacturer **Suphammer**, product
**Suphacap 2**, and firmware profile `rcp-controller`. Its firmware version comes
from the running radio's standard RCP `GetFirmwareInfo` response. These display
names do not allocate Z-Wave numeric IDs. The internal compatibility layer still
uses reserved/unassigned Manufacturer ID `0xffff`, Product Type `0`, and Product
ID `0`; those values are not a private Suphammer allocation and must not be used
to identify other nodes or create device database entries. Official manufacturer
identity requires an assigned ID from the Z-Wave manufacturer list.

`lib/suphacap/Firmware.ts` defines the Driver's minimum compatible firmware
(`0.1.4`) and recommended source baseline (`0.1.6`). Startup requires both the
minimum version and the negotiated MAC-assist version 1/capability mask `0x33`.
Explorer TX and beaming remain separately negotiated. An older version produces
an error naming the observed and required versions; newer compatible firmware
is accepted. A version below the recommended baseline can remain compatible,
so applications should present it as an update recommendation rather than a
startup failure. The baseline is not a claim about the latest online release
or the Silicon Labs Z-Wave SDK version.

## Adding another radio

A radio implementation supplies the `SoftwareControllerRadio` contract and
is injected into `SoftwareController` through its radio factory. It handles
its own connection and wire protocol and validates the final result of
each physical operation. Z-Wave inclusion, replication, routing, and state
logic remain in `lib/softcontroller`.

A new Driver adapter also selects its supported capabilities and manages
its physical connection. The shared software-controller Driver backend uses
the Driver's existing database bindings for controller state and ownership.
A durable database flush is required before committed network changes can
report success. The current
public configuration exposes only Serial API and Suphacap; the radio
interface is internal and is not yet a stable third-party plugin API.
An additional radio needs its own hardware validation before it can be
advertised as supported.

The initial software controller and Suphacap implementation were adapted
from the MIT-licensed [Suphacap V2 host tools](https://github.com/suphammer/suphacap2/tree/327cd8b/tools/zwave-js).
Imported files retain Jon Suphammer's copyright and MIT notices. The
repository's existing license and notices continue to apply to its other
code.
