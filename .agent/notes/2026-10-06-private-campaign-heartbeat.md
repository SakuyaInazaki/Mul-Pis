# Private campaign heartbeat

The private campaign's long-running Actions step previously offered no intermediate liveness signal. The workflow explicitly enables the driver heartbeat only in GitHub Actions and opens a dedicated file descriptor. Outside that explicit launch context, the heartbeat is disabled and does not touch file descriptor 3. When enabled, the driver emits one fixed public line when its Node event loop starts and every 60 seconds while that loop remains responsive. Campaign stdout and stderr remain redirected to private runner files. The observation timer is unreferenced and stopped after the driver settles, and an observer write failure cannot change the research outcome.

This signal does not establish provider activity, scientific progress, or the absence of a blocked synchronous operation. A missed signal is not a timeout or stop condition. The change adds no fee, time, call-count, output, or research-round limit, and does not alter the scientific adapter or encrypted result transport.

Offline tests cover default-disabled behavior, fixed-text behavior, observer failure, timer cleanup, actual helper emission through the descriptor, descriptor ordering, and stdout/stderr separation. No live paid campaign was started for this change.
