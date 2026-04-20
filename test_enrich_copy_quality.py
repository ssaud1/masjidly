import unittest

from enrich_all_masjids import build_fallback_description, sanitize_speaker


class TestEnrichCopyQuality(unittest.TestCase):
    def test_sanitize_speaker_removes_nav_noise(self):
        self.assertEqual(sanitize_speaker("Imam Corner Imam Job Description"), "")

    def test_fallback_description_respects_sisters_only(self):
        event = {
            "title": "Dars (Sisters only) - Islamic Center of East Brunswick",
            "source": "iceb",
            "location_name": "Islamic Center of East Brunswick",
            "date": "2026-04-17",
            "start_time": "5:30 pm",
            "audience": "",
            "description": "",
            "category": "",
        }
        desc = build_fallback_description(event)
        self.assertIn("intended for sisters", desc.lower())
        self.assertNotIn("community members are welcome", desc.lower())


if __name__ == "__main__":
    unittest.main()
