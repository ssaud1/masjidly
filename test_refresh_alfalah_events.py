import unittest

from refresh_alfalah_events import build_event, dedupe, parse_day_label_to_iso


class TestRefreshAlfalahEvents(unittest.TestCase):
    def test_build_event_extracts_registration_and_poster(self):
        raw = {
            "eventId": "0b8ba138-2fed-47b7-8fbb-9bca174d2e76",
            "eventTitle": "Women’s Shotokan Karate classes",
            "eventDescription": None,
            "eventBannerImage": "https://media.madinaapps.com/prod/kiosk-cp-media/client_219/gallery-items/1ff7703d-a017-472c-bf28-13850c8103d5.jpeg",
            "eventCategory": "Health and Fitness Committee (Sports Committee)",
            "eventActionUrl": "https://docs.google.com/forms/d/e/1FAIpQLSevxxMaI59YfAViP1dfEeid2S9-VX0nE31tGm8K3s5_js1rFw/viewform",
            "eventActionText": "REGISTRATION",
            "eventRegistrationOpen": True,
            "eventStartDate": "2026-04-02 18:30:00",
            "eventEndDate": "2026-04-02 19:30:00",
        }
        item = build_event(raw, default_date_iso="2026-04-02", source_url="https://alfalahcenter.org/events/")
        self.assertIsNotNone(item)
        self.assertEqual(item["title"], "Women’s Shotokan Karate classes")
        self.assertEqual(item["date"], "2026-04-02")
        self.assertEqual(item["start_time"], "18:30")
        self.assertEqual(item["end_time"], "19:30")
        self.assertIn("docs.google.com/forms", item["rsvp_link"])
        self.assertEqual(len(item["image_urls"]), 1)

    def test_build_event_handles_next_month_example(self):
        raw = {
            "eventId": "a1b65ecd-7eaa-423c-8173-08ae33eb960c",
            "eventTitle": "My Deen Program: Seerah of the Prophet ﷺ – The Madani Era (MiddleSchooler)",
            "eventDescription": "Students will learn about the life of the Prophet ﷺ.",
            "eventBannerImage": "https://media.madinaapps.com/prod/kiosk-cp-media/client_219/gallery-items/31cf73ad-2df5-4441-b4f8-630a87d6dad5.jpeg",
            "eventCategory": "Religious Programming",
            "eventActionUrl": "https://forms.madinaapps.com/alfalahcenter/a245d6b1-3c77-407b-88d3-a358c1bfa4fb",
            "fromTime": "5:30 PM",
            "toTime": "6:30 PM",
        }
        item = build_event(raw, default_date_iso="2026-05-27", source_url="https://alfalahcenter.org/events/")
        self.assertIsNotNone(item)
        self.assertEqual(item["date"], "2026-05-27")
        self.assertEqual(item["start_time"], "17:30")
        self.assertEqual(item["end_time"], "18:30")
        self.assertIn("forms.madinaapps.com/alfalahcenter", item["rsvp_link"])

    def test_dedupe_removes_duplicate_event_rows(self):
        rows = [
            {
                "title": "Women’s Shotokan Karate classes",
                "date": "2026-04-02",
                "start_time": "18:30",
                "rsvp_link": "https://docs.google.com/forms/d/e/foo/viewform",
            },
            {
                "title": "Women’s Shotokan Karate classes",
                "date": "2026-04-02",
                "start_time": "18:30",
                "rsvp_link": "https://docs.google.com/forms/d/e/foo/viewform",
            },
        ]
        out = dedupe(rows)
        self.assertEqual(len(out), 1)

    def test_parse_day_label_to_iso(self):
        self.assertEqual(parse_day_label_to_iso("27 May 2026"), "2026-05-27")


if __name__ == "__main__":
    unittest.main()
