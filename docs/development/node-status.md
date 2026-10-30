# Automatic node status checks

Driver startup and the interview's reachability check use the internal
`determineStatus()` helper. It first performs the existing short NOP ping.
After failure, a known always-listening Z-Wave Classic node may receive exactly
one additional NOP that permits route resolution and Explorer fallback.
Sleeping, FLiRS, Long Range, and unknown-capability nodes retain the short check.

Concurrent status checks on the same node share one operation. Before probing
and after each awaited result, the helper checks Driver/controller readiness,
the Home ID, and the same included node object. The additional attempt requires
idle commissioning. It does not require an otherwise empty send queue.

The public `ping(false)` behavior remains unchanged. There is no periodic
recovery loop, application-command replay, forced-Awake state, or vendor-specific
policy. The existing Driver queues and backend transaction deadlines govern
each NOP; route resolution can add several seconds to an unreachable node's
status check.

Normal status events remain authoritative. A failed short ping may briefly
mark a node Dead before the additional attempt recovers it to Alive. A successful
NOP does not establish application-command support, and an unsuccessful status
check does not delete membership or prove that the device hardware is defective.
