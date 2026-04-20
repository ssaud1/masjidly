import unittest

from enrich_all_masjids import sanitize_event_images


class TestSanitizeEventImages(unittest.TestCase):
    def test_darul_islah_jummah_drops_unrelated_weekdays_poster(self):
        event = {"source": "darul_islah", "title": "Jummah"}
        imgs = [
            "https://www.darulislah.org/wp-content/uploads/2025/09/Weekdays-With-Sheikh-2-819x1024.png",
            "http://www.darulislah.org/wp-content/uploads/2025/02/Facebook-Negative.png",
        ]
        out = sanitize_event_images(event, imgs)
        self.assertEqual(out, [])

    def test_darul_islah_di_juniors_drops_unrelated_weekdays_poster(self):
        event = {"source": "darul_islah", "title": "DI Juniors (Girls)"}
        imgs = [
            "https://www.darulislah.org/wp-content/uploads/2025/09/Weekdays-With-Sheikh-2-819x1024.png",
            "http://www.darulislah.org/wp-content/uploads/2025/03/footer-i1.png",
        ]
        out = sanitize_event_images(event, imgs)
        self.assertEqual(out, [])

    def test_non_sensitive_titles_keep_matching_poster(self):
        event = {"source": "darul_islah", "title": "Sisters' Halaqa"}
        imgs = [
            "https://www.darulislah.org/wp-content/uploads/2025/09/Sr.-Sherins-Halaqa-Real-Estate-Flyer-11.png",
            "http://www.darulislah.org/wp-content/uploads/2025/02/Facebook-Negative.png",
        ]
        out = sanitize_event_images(event, imgs)
        self.assertEqual(
            out,
            ["https://www.darulislah.org/wp-content/uploads/2025/09/Sr.-Sherins-Halaqa-Real-Estate-Flyer-11.png"],
        )


if __name__ == "__main__":
    unittest.main()
