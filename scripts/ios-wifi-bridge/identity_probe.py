"""Read an already-paired Wi-Fi identity without opening developer services.

This reuses the paired TCP selection from the existing Wi-Fi adapter. UI
authentication must not create or retire a second CoreDevice/RSD tunnel while
an independently owned XCTest runner is using its persistent connection.
"""
import argparse
import asyncio
import json
import plistlib
from pathlib import Path

from pymobiledevice3.lockdown import create_using_tcp


async def read_identity(args):
    async with asyncio.timeout(15):
        pair_file = Path.home() / ".pymobiledevice3" / (args.udid + ".plist")
        pair_record = plistlib.loads(pair_file.read_bytes())
        lockdown = await create_using_tcp(
            hostname=args.host, identifier=args.udid,
            autopair=False, pair_record=pair_record,
        )
        try:
            if lockdown.all_values.get("UniqueDeviceID") != args.udid:
                raise RuntimeError("Wi-Fi device identity mismatch")
            if not lockdown.paired and not await lockdown.validate_pairing():
                raise RuntimeError("Stored Wi-Fi pairing was rejected by the iPhone")
            print(json.dumps({
                "transport": "WIFI_TCP", "udid": args.udid,
                "productVersion": lockdown.product_version,
                "result": "CONNECTED", "scope": "PAIRED_LOCKDOWN_IDENTITY_ONLY",
                "developerTunnelOpened": False,
            }), flush=True)
        finally:
            await lockdown.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--udid", required=True)
    parser.add_argument("--host", required=True)
    asyncio.run(read_identity(parser.parse_args()))
