#!/usr/bin/env python3
"""Audit and compile a complete private pair outside the public repository.

Usage: build_private_pair.py PRIVATE_CONFIG.json PRIVATE_OUTPUT_DIR --node NODE
The output manifest is for a trusted owner's private-storage uploader only.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

from build_bank_paper import assemble
from build_paper import build, outside_site

ROOT = Path(__file__).resolve().parent.parent

def sha256(filename):
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()


def build_private_pair(config_path, output_dir, node='node'):
    config_path = outside_site(config_path, 'Private configuration')
    output_dir = outside_site(output_dir, 'Private output')
    config = json.loads(config_path.read_text())
    result = subprocess.run([node, str(ROOT / 'tools/validate-private-pair.mjs'), str(config_path)],
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'Private content review failed')
    audit = json.loads(result.stdout)
    def verify_inputs():
        if any(sha256(filename) != expected for filename, expected in audit['inputs'].items()):
            raise ValueError('Reviewed source or audit changed during compilation; rerun the reviews')
    verify_inputs()
    read_private = lambda name: json.loads(outside_site(config_path.parent / name, 'Private input').read_text())
    private_bank = read_private(config['bank'])
    public_bank = json.loads((ROOT / 'content/official-question-bank.json').read_text())
    bank = {'version': 1, 'questions': {**public_bank['questions'], **private_bank['questions']}}
    manifest = {'version': 1, 'visibility': 'private', 'pairId': audit['pairId'], 'editionId': audit['editionId'], 'papers': []}
    with tempfile.TemporaryDirectory(prefix='tmua-private-pair-') as temporary:
        staging = Path(temporary)
        compiled = []
        for plan_file in config['plans']:
            plan = read_private(plan_file)
            data = assemble(plan, bank, allow_private=True)
            # The exact bank, including every empty recall array, has already
            # passed validateRecallOmissions with independent evidence. The
            # legacy renderer treats missing and empty recall identically;
            # omit only these keys in the transient build input, not the bank.
            recall_omissions = []
            for group in data['questions']:
                for question in [group['original'], *group['similar']]:
                    for index, hint in enumerate(question['hints'], start=1):
                        if hint.get('recall') == []:
                            del hint['recall']
                            recall_omissions.append({'sourceId': question['sourceId'], 'hintNumber': index})
            metadata = copy.deepcopy(data['metadata'])
            paper_id = metadata['id']
            object_path = f"{paper_id}/{audit['editionId']}.html"
            source = staging / f'{paper_id}.json'
            source.write_text(json.dumps(data, ensure_ascii=False))
            html = staging / object_path
            build(source, html, allow_private=True)
            if html.stat().st_size > 15 * 1024 * 1024:
                raise ValueError('Private standalone paper exceeds the 15 MB upload limit')
            manifest['papers'].append({'paper_id': paper_id, 'edition_id': audit['editionId'],
                'pair_id': audit['pairId'], 'paper_number': metadata['paper'], 'object_path': object_path,
                'sha256': sha256(html), 'metadata': metadata,
                'presentationNormalizations': {'reviewedEmptyRecallKeysOmitted': recall_omissions},
                'concept_mapping': next(mapping for mapping in audit['mappings'] if mapping['paper']['id'] == paper_id)})
            compiled.append((html, outside_site(output_dir / object_path, 'Private HTML')))
        verify_inputs()
        manifest['papers'].sort(key=lambda row: row['paper_number'])
        manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
        destination = outside_site(output_dir / 'manifest.json', 'Private manifest')
        outputs = [(source, target, source.read_bytes()) for source, target in compiled] + [(None, destination, manifest_bytes)]
        # Check all collisions before writing either member; no previous edition is overwritten.
        for _, target, contents in outputs:
            if target.exists() and target.read_bytes() != contents:
                raise ValueError(f'Immutable private edition already exists with different bytes: {target.name}')
        for _, target, contents in outputs:
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                with target.open('xb') as handle:
                    handle.write(contents)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    try:
        manifest = build_private_pair(args.config, args.output, args.node)
        print(f"Private pair compiled: {len(manifest['papers'])} papers; no public files or cloud services changed.")
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        parser.exit(1, f'Cannot build private pair: {error}\n')
