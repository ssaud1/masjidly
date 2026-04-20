#!/usr/bin/env python3
import unittest

from event_merge_utils import merge_event_group, merge_fuzzy_duplicate_events, title_key


class TestEventMergeUtils(unittest.TestCase):
    def test_title_key_strips_noise(self) -> None:
        self.assertEqual(title_key("  Youth  Night!!!  "), "youth night")

    def test_merge_event_group_prefers_website_rsvp(self) -> None:
        website = {
            "source": "icpc",
            "source_type": "website",
            "title": "Youth Night",
            "date": "2026-05-01",
            "start_time": "7:00 PM",
            "rsvp_link": "",
            "description": "Short.",
        }
        email = {
            "source": "icpc",
            "source_type": "email",
            "title": "Youth Night",
            "date": "2026-05-01",
            "start_time": "",
            "rsvp_link": "https://eventbrite.com/e/123",
            "description": "Longer description from the email blast.",
        }
        merged = merge_event_group([website, email])
        self.assertEqual(merged["source_type"], "website")
        self.assertIn("eventbrite", merged["rsvp_link"].lower())
        self.assertGreater(len(merged["description"]), len("Short."))

    def test_merge_fuzzy_duplicate_events_collapses_same_day(self) -> None:
        rows = [
            {
                "source": "mcgp",
                "source_type": "website",
                "title": "Community Iftar",
                "date": "2026-04-20",
                "start_time": "7:30 PM",
                "location_name": "MCGP",
                "address": "",
                "rsvp_link": "",
            },
            {
                "source": "mcgp",
                "source_type": "instagram",
                "title": "Community Iftar Dinner",
                "date": "2026-04-20",
                "start_time": "7:30 PM",
                "location_name": "MCGP",
                "address": "",
                "rsvp_link": "https://forms.gle/abc",
            },
        ]
        out = merge_fuzzy_duplicate_events(rows)
        self.assertEqual(len(out), 1)
        self.assertIn("forms.gle", out[0].get("rsvp_link", ""))


if __name__ == "__main__":
    unittest.main()
