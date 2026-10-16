# Project-authored mobile-cli-allinone Wi-Fi adaptation.
# Requires separately installed pymobiledevice3; no dependency source,
# device configuration, pairing records or signing material is bundled.
"""Optional explicit Wi-Fi adapter for pymobiledevice3 11.32.0.

The stock userspace CLI selects usbmux before considering --mobdev2. This
adapter connects to the requested, already-paired LAN device instead. It
does not change pymobiledevice3, install profiles, or expose a LAN server.
"""

import argparse
import asyncio
import json
import plistlib
from contextlib import AsyncExitStack, aclosing, asynccontextmanager, suppress
from pathlib import Path

from pymobiledevice3.lockdown import create_using_tcp, get_mobdev2_lockdowns
from pymobiledevice3.remote import tunnel_service
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.userspace_tunnel import UserspaceDialPlane
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.process_control import ProcessControl
from pymobiledevice3.services.dvt.instruments.screenshot import Screenshot


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


@asynccontextmanager
async def wifi_device(udid, host=None, lockdown_only=False):
    """Keep the paired TCP transport, tunnel and services in one owned scope."""
    previous_factory = tunnel_service.USE_USERSPACE_TUNNEL
    try:
        async with AsyncExitStack() as resources:
            # Discovery may return an unpaired client. Only an existing valid
            # record is accepted before starting protected device services.
            if host:
                # TcpLockdownClient uses its host address as identifier. Supply
                # the real device's private pair record instead of allowing an
                # IPv6 address to become an invalid Windows plist filename.
                pair_file = Path.home() / ".pymobiledevice3" / (udid + ".plist")
                pair_record = plistlib.loads(pair_file.read_bytes())
                lockdown = await create_using_tcp(
                    hostname=host, identifier=udid, autopair=False, pair_record=pair_record,
                )
            else:
                async with aclosing(get_mobdev2_lockdowns(udid=udid, only_paired=True)) as discovery:
                    async for address, lockdown in discovery:
                        if lockdown.all_values.get("UniqueDeviceID") == udid:
                            break
                        await lockdown.close()
                    else:
                        raise RuntimeError("Requested paired iPhone was not found over Wi-Fi")
            resources.push_async_callback(lockdown.close)
            if lockdown.all_values.get("UniqueDeviceID") != udid:
                raise RuntimeError("Wi-Fi device identity mismatch")
            if not lockdown.paired and not await lockdown.validate_pairing():
                raise RuntimeError("Stored Wi-Fi pairing was rejected by the iPhone")
            emit({"transport": "WIFI_TCP", "udid": udid,
                  "productType": lockdown.all_values.get("ProductType"),
                  "productVersion": lockdown.product_version,
                  "developerMode": await lockdown.get_developer_mode_status()})
            # Wi-Fi lockdown needs Apple's Marco/Polo exchange. A TCP keepalive
            # alone allows initial queries but protected services are torn down.
            heartbeat = await lockdown.start_lockdown_service("com.apple.mobile.heartbeat")
            resources.push_async_callback(heartbeat.close)
            await heartbeat.recv_plist()
            await heartbeat.send_plist({"Command": "Polo"})
            async def keep_network_session():
                while True:
                    await heartbeat.recv_plist()
                    await heartbeat.send_plist({"Command": "Polo"})
            heartbeat_task = asyncio.create_task(keep_network_session())
            async def cancel_heartbeat():
                heartbeat_task.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat_task
            resources.push_async_callback(cancel_heartbeat)
            if lockdown_only:
                yield lockdown, lockdown
                return
            tunnel_service.USE_USERSPACE_TUNNEL = True
            # CoreDeviceProxy works over paired Wi-Fi while Marco/Polo is alive.
            # No USB discovery or transport fallback is used here.
            provider = await tunnel_service.CoreDeviceTunnelProxy.create(lockdown)
            resources.push_async_callback(provider.close)
            result = await resources.enter_async_context(provider.start_tcp_tunnel())
            tun = result.client.tun
            tun.set_peer(result.address)
            dial = await resources.enter_async_context(UserspaceDialPlane(tun, result.address))
            rsd = RemoteServiceDiscoveryService(
                (result.address, result.port), open_connection=dial.dial,
                auxiliary_metadata=result.auxiliary_metadata,
            )
            resources.push_async_callback(rsd.close)
            await rsd.connect()
            if rsd.udid != udid:
                raise RuntimeError("Developer tunnel device identity mismatch")
            yield lockdown, rsd
    finally:
        tunnel_service.USE_USERSPACE_TUNNEL = previous_factory


async def execute(args):
    # A deadline bounds actual discovery/RPC work; no polling or blind waits.
    async with asyncio.timeout(45), wifi_device(args.udid, args.host, args.lockdown) as (lockdown, rsd):
        if args.action == "probe":
            emit({"developerServices": len(rsd.peer_info.get("Services", {})), "result": "CONNECTED"})
            return
        async with DvtProvider(rsd) as dvt:
            if args.action == "launch":
                if not args.bundle:
                    raise ValueError("launch requires --bundle")
                pid = await ProcessControl(dvt).launch(args.bundle, kill_existing=False)
                emit({"action": "launch", "bundle": args.bundle, "pid": pid})
            if args.action == "screenshot" or args.output:
                if not args.output:
                    raise ValueError("screenshot requires --output")
                output = Path(args.output).resolve()
                if output.exists():
                    raise FileExistsError(output)
                async with Screenshot(dvt) as capture:
                    data = await capture.get_screenshot()
                output.write_bytes(data)
                emit({"action": "screenshot", "path": str(output), "bytes": len(data)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["probe", "screenshot", "launch"])
    parser.add_argument("--udid", required=True)
    parser.add_argument("--host", help="Last observed LAN address; identity is still verified using UDID")
    parser.add_argument("--lockdown", action="store_true", help="Use Wi-Fi lockdown directly; do not fall back to USB")
    parser.add_argument("--bundle")
    parser.add_argument("--output")
    args = parser.parse_args()
    asyncio.run(execute(args))


if __name__ == "__main__":
    main()
