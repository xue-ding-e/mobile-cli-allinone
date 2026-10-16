# Project-authored mobile-cli-allinone Wi-Fi adaptation.
# Requires separately installed pymobiledevice3; no dependency source,
# device configuration, pairing records or signing material is bundled.
"""Install only on the explicitly paired iPhone over its authenticated Wi-Fi channel."""
import argparse
import asyncio
import hashlib
import json
import plistlib
import shutil
import tempfile
import zipfile
from pathlib import Path
from xml.parsers.expat import ExpatError
from device import wifi_device
from pymobiledevice3.services.installation_proxy import InstallationProxyService


def read_package_identity(package, expected_bundle):
    """Validate the main app before opening any authenticated device transport."""
    try:
        with zipfile.ZipFile(package) as archive:
            entries = archive.infolist()
            main_apps = set()
            for entry in entries:
                name = entry.orig_filename
                parts = name.rstrip('/').split('/')
                if ('\x00' in name or '\\' in name or name.startswith('/')
                        or any(part in ('', '.', '..') for part in parts)
                        or ':' in parts[0]):
                    raise ValueError('IPA contains an unsafe archive path')
                if len(parts) >= 2 and parts[0] == 'Payload' and parts[1].endswith('.app'):
                    main_apps.add(parts[1])
            if len(main_apps) != 1:
                raise ValueError('IPA must contain exactly one main Payload/*.app')
            plist_name = 'Payload/' + next(iter(main_apps)) + '/Info.plist'
            plists = [entry for entry in entries if entry.filename == plist_name]
            if len(plists) != 1 or plists[0].is_dir():
                raise ValueError('IPA must contain exactly one main app Info.plist')
            if plists[0].file_size > 1024 * 1024:
                raise ValueError('IPA main app Info.plist exceeds the 1 MiB limit')
            identity = plistlib.loads(archive.read(plists[0]))
    except (zipfile.BadZipFile, plistlib.InvalidFileException, ExpatError, EOFError, RuntimeError) as error:
        raise ValueError('IPA main app metadata could not be read') from error
    if not isinstance(identity, dict):
        raise ValueError('IPA main app Info.plist must be a dictionary')
    bundle = identity.get('CFBundleIdentifier')
    if not isinstance(bundle, str) or not bundle.strip() or bundle != expected_bundle:
        raise ValueError('IPA main app CFBundleIdentifier does not match --bundle')
    version = identity.get('CFBundleVersion')
    if not isinstance(version, str) or not version.strip():
        raise ValueError('IPA main app CFBundleVersion must be a non-empty string')
    short_version = identity.get('CFBundleShortVersionString')
    if short_version is not None and (not isinstance(short_version, str) or not short_version.strip()):
        raise ValueError('IPA main app CFBundleShortVersionString must be a non-empty string when present')
    return {'bundle': bundle, 'version': version, 'shortVersion': short_version}


async def main(args):
    input_package = Path(args.package).resolve()
    # Caller-owned build paths can change while device RPCs are pending. The
    # metadata, hash and installer must all consume this one owned snapshot.
    with tempfile.TemporaryDirectory(prefix='mobile-ios-install-') as directory:
        package = Path(directory) / 'validated.ipa'
        shutil.copyfile(input_package, package)
        expected = read_package_identity(package, args.bundle)
        with package.open('rb') as source:
            package_hash = hashlib.file_digest(source, 'sha256').hexdigest()
        print(json.dumps({'package': str(input_package), 'inputMode': 'PRIVATE_INSTALL_SNAPSHOT', 'sha256': package_hash, **expected}), flush=True)
        async with asyncio.timeout(180), wifi_device(args.udid, args.host, lockdown_only=True) as (lockdown, _):
            async with InstallationProxyService(lockdown) as proxy:
                await proxy.install_from_local(package, developer=True)
                apps = await proxy.lookup({'BundleIDs': [args.bundle]})
                app = apps.get(args.bundle) if isinstance(apps, dict) else None
                if not isinstance(app, dict):
                    raise RuntimeError('Installed bundle not returned by device')
                if app.get('CFBundleIdentifier') != expected['bundle']:
                    raise RuntimeError('Installed CFBundleIdentifier does not match the IPA')
                if app.get('CFBundleVersion') != expected['version']:
                    raise RuntimeError('Installed CFBundleVersion does not match the IPA')
                if expected['shortVersion'] is not None and app.get('CFBundleShortVersionString') != expected['shortVersion']:
                    raise RuntimeError('Installed CFBundleShortVersionString does not match the IPA')
                print(json.dumps({'result': 'INSTALLED_AND_LOOKED_UP', 'transport': 'WIFI_TCP', 'udid': args.udid, 'bundle': app['CFBundleIdentifier'], 'version': app['CFBundleVersion'], 'shortVersion': app.get('CFBundleShortVersionString'), 'path': app.get('Path')}), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['package', 'udid', 'host', 'bundle']:
        parser.add_argument('--' + name, required=True)
    asyncio.run(main(parser.parse_args()))
