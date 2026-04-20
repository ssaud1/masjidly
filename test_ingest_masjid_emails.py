import unittest

from ingest_masjid_emails import SOURCE_META, detect_source, infer_masjid_source_from_blob


class TestIngestMasjidEmails(unittest.TestCase):
    def test_detect_source_for_iscj_sender(self):
        sender = "ISCJ Admin <admin-iscj.org@shared1.ccsend.com>"
        self.assertEqual(detect_source(sender), "iscj")

    def test_iscj_source_metadata_present(self):
        self.assertIn("iscj", SOURCE_META)
        self.assertIn("Monmouth Junction", SOURCE_META["iscj"]["address"])

    def test_detect_source_for_icpc_sender(self):
        sender = "ICPC <noreply@icpcnj.org>"
        self.assertEqual(detect_source(sender), "icpc")

    def test_icsj_org_parish_email_not_mapped_to_nj_icsj(self):
        """icsj.org is an unrelated org (e.g. parish mail); must not tag NJ ICSJ."""
        sender = "Parish <gsnow@icsj.org>"
        self.assertIsNone(detect_source(sender))

    def test_icsj_nj_masjid_domain_maps(self):
        sender = "ICSJ <newsletter@icsjmasjid.org>"
        self.assertEqual(detect_source(sender), "icsj")

    def test_infer_source_from_org_url_in_footer(self):
        blob = "List-Unsubscribe: <https://us8.list-manage.com/x> visit https://www.icpcnj.org/events"
        hit = infer_masjid_source_from_blob(blob)
        self.assertIsNotNone(hit)
        self.assertEqual(hit[1], "icpc")

    def test_infer_no_false_positive_on_generic_mail(self):
        self.assertIsNone(infer_masjid_source_from_blob("thread about lunch plans on gmail.com only"))

    def test_icpc_source_metadata_present(self):
        self.assertIn("icpc", SOURCE_META)
        self.assertIn("Paterson", SOURCE_META["icpc"]["address"])


if __name__ == "__main__":
    unittest.main()
