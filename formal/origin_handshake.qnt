// One request at the edge. Status classes are finite representatives; the
// origin/runtime owns authentication, RFC6455 validation, frames and closure.
module origin_handshake {
  type Phase = Start | Forward | Done
  type State = {
    mode: str, status: int, has_socket: bool, edge_owned: bool,
    phase: Phase, outcome: str, status_returned: int,
    origin_called: bool, upgrade_forwarded: bool,
    manual_redirect: bool, socket_passed: bool,
  }
  var s: State

  action init = {
    nondet mode = Set("http", "websocket", "reject").oneOf()
    nondet status = Set(0, 101, 200, 201, 204, 301, 302, 303, 307, 308,
      400, 401, 403, 404, 426, 500, 502, 503, 504, 521, 522, 523, 524).oneOf()
    nondet has_socket = Set(false, true).oneOf()
    nondet edge_owned = Set(false, true).oneOf()
    s' = {
      mode: mode, status: status, has_socket: has_socket, edge_owned: edge_owned, phase: Start,
      outcome: "pending", status_returned: 0, origin_called: false,
      upgrade_forwarded: false, manual_redirect: false, socket_passed: false,
    }
  }

  val upgraded = s.mode == "websocket" and s.status == 101 and s.has_socket
  val unavailable = or {
    Set(0, 502, 503, 504, 521, 522, 523, 524).contains(s.status),
    s.status == 404 and s.edge_owned,
    s.status == 101 and not(upgraded),
  }
  action step = match s.phase {
    | Start => s' = if (s.mode == "reject") {
        ...s, phase: Done, outcome: "reject", status_returned: 400,
      } else { ...s, phase: Forward }
    | Forward => s' = {
        ...s, phase: Done, origin_called: true,
        upgrade_forwarded: s.mode == "websocket", manual_redirect: true,
        socket_passed: upgraded,
        outcome: if (upgraded) "upgrade" else if (unavailable) "unavailable" else "http",
        status_returned: if (unavailable) 503 else s.status,
      }
    | Done => s' = s
  }

  val protocol_safety = and {
    (s.outcome == "pending") == (s.phase != Done),
    s.mode != "reject" or not(s.origin_called),
    s.outcome != "upgrade" or and {
      upgraded, s.origin_called, s.upgrade_forwarded, s.socket_passed,
    },
    not(s.socket_passed) or s.outcome == "upgrade",
    not(s.origin_called) or s.manual_redirect,
    not(s.upgrade_forwarded) or s.mode == "websocket",
    s.phase != Done or s.mode == "reject" or not(unavailable)
      or (s.outcome == "unavailable" and s.status_returned == 503),
    s.phase != Done or s.mode == "reject"
      or not(Set(401, 403, 301, 302, 303, 307, 308).contains(s.status))
      or (s.outcome == "http" and s.status_returned == s.status),
  }

  val upgrade_reached = s.outcome == "upgrade"
  val rejected_before_origin = s.outcome == "reject" and not(s.origin_called)
  val denial_preserved = s.phase == Done and s.status == 403 and s.status_returned == 403
  val redirect_preserved = s.phase == Done and s.status == 307 and s.status_returned == 307
  val failure_unavailable = s.status == 0 and s.outcome == "unavailable"
  val malformed_upgrade_rejected = s.status == 101 and s.outcome == "unavailable"
  val entry_not_found_unavailable = s.status == 404 and s.edge_owned and s.outcome == "unavailable"
}
