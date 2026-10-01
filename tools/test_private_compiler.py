"""Private compilation cannot leak paid payloads into the public library."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from build_bank_paper import assemble
from build_paper import build, is_private_original, outside_site, validate

ROOT = Path(__file__).resolve().parent.parent
BANK = json.loads((ROOT / 'content/official-question-bank.json').read_text())
LESSONS = ROOT / 'content/studied-lessons.json'
CONCEPTS = ROOT / 'assets/studied-concepts.json'


def fixture():
    question = copy.deepcopy(BANK['questions']['2020-P2-Q01'])
    question.update(sourceId='TYLER-EXAM-A-P1-Q01', provider='jzmaths-tyler', source='Private synthetic test fixture', sourceUrl='https://jzmaths.com/simulator/tyler_exam_a_p1')
    metadata = {'format': 'tmua-paper-v1', 'id': 'tyler-exam-a-p1', 'title': 'Private test', 'paper': 1,
        'version': 1, 'source': 'Private test', 'description': '', 'questionCount': 1,
        'practicePolicy': 'after-miss-up-to-3', 'visibility': 'private', 'provider': 'jzmaths-tyler', 'pairId': 'tyler-exam-a'}
    return {'metadata': metadata, 'questions': [{'id': 'q1', 'original': question, 'similar': [copy.deepcopy(BANK['questions']['2021-P1-Q01'])]}]}


class PrivateCompilerTests(unittest.TestCase):
    def test_default_compiler_rejects_private_even_without_adaptive_policy(self):
        for adaptive in (True, False):
            data = fixture()
            if not adaptive:
                data['metadata'].pop('practicePolicy')
            with self.assertRaisesRegex(ValueError, 'audited private-pair compiler'):
                validate(data, LESSONS, CONCEPTS)

    def test_private_origin_identity_and_url_are_not_relabelled(self):
        data = validate(fixture(), LESSONS, CONCEPTS, allow_private=True)
        self.assertEqual(data['questions'][0]['original']['provider'], 'jzmaths-tyler')
        self.assertEqual(data['questions'][0]['similar'][0]['provider'], 'official-tmua')
        for key, value in [('sourceUrl', 'https://jzmaths.com/simulator/tyler_mock_a_p1'),
                           ('sourceUrl', 'https://user:secret@jzmaths.com/simulator/tyler_exam_a_p1'),
                           ('sourceId', '2020-P1-Q01'), ('provider', 'official-tmua')]:
            changed = fixture(); changed['questions'][0]['original'][key] = value
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, 'exact provider'):
                validate(changed, LESSONS, CONCEPTS, allow_private=True)

    def test_private_flow_and_followup_restrictions_still_apply(self):
        data = fixture()
        data['questions'][0]['original'].update(sourceId='TYLER-EXAM-B-P1-Q01', sourceUrl='https://jzmaths.com/simulator/tyler_exam_b_p1')
        with self.assertRaisesRegex(ValueError, 'exact provider'):
            validate(data, LESSONS, CONCEPTS, allow_private=True)
        for legacy in ([copy.deepcopy(data['questions'][0]['original'])], None, 'unexpected'):
            data = fixture(); data['questions'][0]['legacySimilar'] = legacy
            with self.assertRaisesRegex(ValueError, 'unaudited legacy'):
                validate(data, LESSONS, CONCEPTS, allow_private=True)
        data = fixture(); data['metadata'].pop('practicePolicy')
        with self.assertRaisesRegex(ValueError, 'after-miss'):
            validate(data, LESSONS, CONCEPTS, allow_private=True)
        data = fixture(); data['questions'][0]['similar'] = [copy.deepcopy(data['questions'][0]['original'])]
        with self.assertRaises(ValueError):
            validate(data, LESSONS, CONCEPTS, allow_private=True)
        data = fixture(); data['questions'][0]['similar'] *= 4
        with self.assertRaisesRegex(ValueError, 'zero to three'):
            validate(data, LESSONS, CONCEPTS, allow_private=True)

    def test_source_and_output_must_be_outside_repository_including_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'private.json';source.write_text(json.dumps(fixture()))
            with self.assertRaisesRegex(ValueError, 'outside the public repository'):
                build(source, ROOT / 'assets/private.html', allow_private=True)
            link = Path(directory) / 'public-assets';link.symlink_to(ROOT / 'assets', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'outside the public repository'):
                outside_site(link / 'private.html')
            with self.assertRaisesRegex(ValueError, 'outside the public repository'):
                build(ROOT / 'content/tmua-2020-p1-plan.json', Path(directory) / 'out.html', allow_private=True)

    def test_another_git_checkout_is_not_a_private_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory) / 'other-checkout'; checkout.mkdir()
            (checkout / '.git').mkdir()
            with self.assertRaisesRegex(ValueError, 'outside the public repository'):
                outside_site(checkout / 'secret.html')

    def test_bank_compiler_requires_explicit_private_entrypoint(self):
        data = fixture(); original = data['questions'][0]['original']; followup = data['questions'][0]['similar'][0]
        bank = {'version':1, 'questions': {q['sourceId']:q for q in [original,followup]}}
        plan = {'metadata':data['metadata'], 'groups':[{'id':'q1','originalId':original['sourceId'],'candidates':[followup['sourceId']]}]}
        with self.assertRaisesRegex(ValueError, 'private-pair compiler'):
            assemble(plan, bank)
        compiled = assemble(plan, bank, allow_private=True)
        self.assertEqual(compiled['questions'][0]['original']['sourceId'], original['sourceId'])


if __name__ == '__main__':
    unittest.main()
