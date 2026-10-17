"""One-time early-development migration. Requires the owner's gcloud login."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request


def encode(value):
    if value is None:
        return {'nullValue': None}
    if isinstance(value, bool):
        return {'booleanValue': value}
    if isinstance(value, str):
        return {'stringValue': value}
    if isinstance(value, int):
        if not -(2**63) <= value < 2**63:
            raise ValueError('Integer exceeds Firestore int64')
        return {'integerValue': str(value)}
    if isinstance(value, float):
        return {'doubleValue': value}
    if isinstance(value, list):
        return {'arrayValue': {'values': [encode(v) for v in value]}}
    if isinstance(value, dict):
        return {'mapValue': {'fields': {k: encode(v) for k, v in value.items()}}}
    raise ValueError('Unsupported JSON value')


def decode(value):
    if 'mapValue' in value:
        return {k: decode(v) for k, v in value['mapValue'].get('fields', {}).items()}
    if 'arrayValue' in value:
        return [decode(v) for v in value['arrayValue'].get('values', [])]
    if 'integerValue' in value:
        return int(value['integerValue'])
    for key in ('nullValue', 'booleanValue', 'stringValue', 'doubleValue'):
        if key in value:
            return value[key]
    raise ValueError('Unsupported Firestore value')


def native_map(field):
    value = json.loads(field['stringValue']) if 'stringValue' in field else decode(field)
    if not isinstance(value, dict):
        raise ValueError('Expected an object')
    encoded = encode(value)
    if decode(encoded) != value:
        raise ValueError('Conversion changed data')
    return encoded


def main():
    sample = {'nested': [{'text': '{"test":true}', 'n': 1792200000000}],
              'empty': {}, 'list': [], 'bool': True, 'null': None, 'float': 1.5}
    assert decode(encode(sample)) == sample
    assert native_map({'stringValue': json.dumps(sample)}) == encode(sample)

    app_dir = Path(os.environ['APPDATA']) / 'dev.aurachat.desktop'
    config = json.loads((app_dir / 'config.json').read_text(encoding='utf-8'))
    project, uid = config['firebase_project_id'], config['uid']
    token = subprocess.check_output(['gcloud.cmd', 'auth', 'print-access-token'], text=True).strip()
    headers = {'Authorization': 'Bearer ' + token, 'X-Goog-User-Project': project}
    base = f'https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents'

    def request(url, body=None):
        payload = None if body is None else json.dumps(body, allow_nan=False).encode('utf-8')
        req = urllib.request.Request(url, data=payload, headers={**headers, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    accounts = request(f'https://identitytoolkit.googleapis.com/v1/projects/{project}/accounts:batchGet?maxResults=1000')
    if accounts.get('nextPageToken') or [u['localId'] for u in accounts.get('users', [])] != [uid]:
        raise RuntimeError('Migration requires exactly one account matching the local UID')
    users = request(base + '/users?pageSize=100')
    if users.get('nextPageToken') or [d['name'].split('/')[-1] for d in users.get('documents', [])] != [uid]:
        raise RuntimeError('Unexpected user documents')
    user = request(base + '/users/' + uid)
    try:
        legacy = request(base + '/data/tree')
    except urllib.error.HTTPError as error:
        if error.code == 404 and all('mapValue' in user['fields'].get(k, {}) for k in ('config', 'tree')):
            print(json.dumps({'status': 'already_migrated', 'project': project, 'uid': uid}))
            return
        raise
    fields = {'config': native_map(user['fields']['config']), 'tree': native_map(legacy['fields']['tree'])}
    if 'tree' in user['fields'] and decode(native_map(user['fields']['tree'])) != decode(fields['tree']):
        raise RuntimeError('Existing per-user history differs; refusing to overwrite it')

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup_dir = app_dir / 'migration-backups' / stamp
    backup_dir.mkdir(parents=True, exist_ok=False)
    backup = {'project': project, 'uid': uid, 'documents': [user, legacy]}
    backup_path = backup_dir / 'firestore-before.json'
    backup_path.write_text(json.dumps(backup, ensure_ascii=False, indent=2), encoding='utf-8')
    if json.loads(backup_path.read_text(encoding='utf-8')) != backup:
        raise RuntimeError('Backup verification failed')

    commit = request(base + ':commit', {'writes': [
        {'update': {'name': user['name'], 'fields': fields},
         'updateMask': {'fieldPaths': ['config', 'tree']},
         'currentDocument': {'updateTime': user['updateTime']}},
        {'delete': legacy['name'], 'currentDocument': {'updateTime': legacy['updateTime']}}
    ]})
    actual = request(base + '/users/' + uid)
    for key in fields:
        if 'mapValue' not in actual['fields'][key] or decode(actual['fields'][key]) != decode(fields[key]):
            raise RuntimeError('Post-migration data verification failed: ' + key)
    for key, value in user['fields'].items():
        if key not in fields and actual['fields'].get(key) != value:
            raise RuntimeError('Unrelated field changed')
    try:
        request(base + '/data/tree')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    else:
        raise RuntimeError('Legacy document still exists')
    tree = decode(fields['tree'])
    result = {'status': 'verified', 'project': project, 'uid': uid,
              'field_types': {k: 'map' for k in fields}, 'legacy_document_removed': True,
              'projects': len(tree.get('projects', [])),
              'standalone_conversations': len(tree.get('conversations', [])),
              'nested_conversations': sum(len(f.get('conversations', [])) for p in tree.get('projects', []) for f in p.get('folders', [])),
              'backup': str(backup_path), 'commitTime': commit['commitTime']}
    (backup_dir / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
