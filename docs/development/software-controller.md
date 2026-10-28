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
