#!/usr/bin/env python3
"""The three-followup readiness gate must reserve a full set for each original."""
import copy
import unittest

from build_bank_paper import assemble


class FollowupCoverageTests(unittest.TestCase):
    def setUp(self):
        self.plan = {'metadata': {'requiresThreeFollowups': True}, 'groups': [
            {'id': 'q1', 'originalId': '2020-P1-Q01',
             'candidates': ['2017-P1-Q01', '2017-P1-Q02', '2017-P1-Q03']},
            {'id': 'q2', 'originalId': '2020-P1-Q02',
             'candidates': ['2017-P1-Q04', '2017-P1-Q05', '2017-P1-Q06']},
        ]}
        ids = [qid for group in self.plan['groups'] for qid in [group['originalId'], *group['candidates']]]
        self.bank = {'version': 1, 'questions': {
            qid: {'sourceId': qid, 'provider': 'official-tmua'} for qid in ids}}

    def test_three_reserved_followups_pass_and_are_copied(self):
        data = assemble(self.plan, self.bank)
        self.assertEqual([len(group['similar']) for group in data['questions']], [3, 3])
        self.assertIsNot(data['questions'][0]['similar'][0], self.bank['questions']['2017-P1-Q01'])

    def test_incomplete_and_excessive_followup_sets_fail(self):
        for count in (0, 1, 2, 4):
            with self.subTest(count=count):
                plan = copy.deepcopy(self.plan)
                plan['groups'][0]['candidates'] = ['2017-P1-Q%02d' % number for number in range(1, count + 1)]
                with self.assertRaisesRegex(ValueError, 'three distinct'):
                    assemble(plan, self.bank)

    def test_reused_candidate_cannot_consume_a_later_questions_reserve(self):
        self.plan['groups'][1]['candidates'][1] = '2017-P1-Q01'
        with self.assertRaisesRegex(ValueError, 'unique across this paper: 2017-P1-Q01'):
            assemble(self.plan, self.bank)

    def test_duplicates_within_one_set_fail(self):
        self.plan['groups'][0]['candidates'][2] = '2017-P1-Q01'
        with self.assertRaisesRegex(ValueError, 'three distinct'):
            assemble(self.plan, self.bank)

    def test_assessment_original_cannot_be_a_followup(self):
        self.plan['groups'][1]['candidates'][0] = '2020-P1-Q01'
        with self.assertRaisesRegex(ValueError, 'from this assessment'):
            assemble(self.plan, self.bank)

    def test_missing_or_nonofficial_candidates_fail(self):
        self.plan['groups'][1]['candidates'][0] = '2016-P1-Q01'
        with self.assertRaisesRegex(ValueError, 'missing from bank'):
            assemble(self.plan, self.bank)
        self.bank['questions']['2016-P1-Q01'] = {'sourceId': '2016-P1-Q01', 'provider': 'invented'}
        with self.assertRaisesRegex(ValueError, 'requires an official'):
            assemble(self.plan, self.bank)

    def test_legacy_plans_keep_optional_and_reused_matches(self):
        for metadata in ({}, {'requiresThreeFollowups': False}):
            with self.subTest(metadata=metadata):
                self.plan['metadata'] = metadata
                self.plan['groups'][0]['candidates'] = ['2017-P1-Q01']
                self.plan['groups'][1]['candidates'] = ['2017-P1-Q01']
                data = assemble(self.plan, self.bank)
                self.assertEqual([len(group['similar']) for group in data['questions']], [1, 1])

    def test_reviewed_fallback_keeps_its_provider_and_source(self):
        sid = 'TMUACO-TRIG-DEG120'
        self.plan['groups'][0]['candidates'][0] = sid
        self.bank['questions'][sid] = {
            'sourceId': sid, 'provider': 'tmua-co-uk',
            'sourceUrl': 'https://tmua.co.uk/practice-bank/trigonometry',
            'fallbackReason': 'Direct unit-conversion practice absent elsewhere in the official archive.'}
        question = assemble(self.plan, self.bank)['questions'][0]['similar'][0]
        self.assertEqual(question['provider'], 'tmua-co-uk')
        for key, value in [('fallbackReason', ''), ('sourceUrl', 'https://example.com/question')]:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.bank)
                changed['questions'][sid][key] = value
                with self.assertRaisesRegex(ValueError, 'requires an official'):
                    assemble(self.plan, changed)

    def test_fallback_cannot_replace_an_assessment_original(self):
        sid = self.plan['groups'][0]['originalId']
        self.bank['questions'][sid]['provider'] = 'tmua-co-uk'
        with self.assertRaisesRegex(ValueError, 'requires an official'):
            assemble(self.plan, self.bank)

    def test_invalid_gate_or_candidate_types_fail(self):
        self.plan['metadata']['requiresThreeFollowups'] = 'true'
        with self.assertRaisesRegex(ValueError, 'must be a boolean'):
            assemble(self.plan, self.bank)
        self.plan['metadata']['requiresThreeFollowups'] = True
        self.plan['groups'][0]['candidates'] = '2017-P1-Q01'
        with self.assertRaisesRegex(ValueError, 'list of source IDs'):
            assemble(self.plan, self.bank)


if __name__ == '__main__':
    unittest.main()
