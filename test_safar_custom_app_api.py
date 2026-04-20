import sqlite3
import unittest
from uuid import uuid4

import safar_custom_app


class TestSafarCustomAppApi(unittest.TestCase):
    def setUp(self):
        self.client = safar_custom_app.app.test_client()
        self.email = f"masjidly-{uuid4().hex[:10]}@example.com"
        self.password = "testpass123"

    def tearDown(self):
        con = sqlite3.connect(safar_custom_app.DB_PATH)
        try:
            row = con.execute("select id from users where email = ?", (self.email,)).fetchone()
            if row:
                user_id = int(row[0])
                con.execute("delete from sessions where user_id = ?", (user_id,))
                con.execute("delete from profiles where user_id = ?", (user_id,))
                con.execute("delete from notification_settings where user_id = ?", (user_id,))
                con.execute("delete from users where id = ?", (user_id,))
                con.commit()
        finally:
            con.close()

    def auth_header(self):
        res = self.client.post("/api/auth/register", json={"email": self.email, "password": self.password})
        self.assertEqual(res.status_code, 200)
        token = res.get_json()["token"]
        return {"Authorization": f"Bearer {token}"}

    def test_register_login_and_profile_update(self):
        register_res = self.client.post("/api/auth/register", json={"email": self.email, "password": self.password})
        self.assertEqual(register_res.status_code, 200)
        token = register_res.get_json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        me = self.client.get("/api/auth/me", headers=headers)
        self.assertEqual(me.status_code, 200)
        self.assertTrue(me.get_json()["authenticated"])

        update = self.client.put(
            "/api/profile",
            headers=headers,
            json={
                "favorite_sources": ["iceb", "alfalah"],
                "audience_filter": "sisters",
                "radius": 20,
                "onboarding_done": True,
            },
        )
        self.assertEqual(update.status_code, 200)

        profile = self.client.get("/api/profile", headers=headers)
        self.assertEqual(profile.status_code, 200)
        payload = profile.get_json()["profile"]
        self.assertEqual(payload["audience_filter"], "sisters")
        self.assertEqual(payload["radius"], 20)
        self.assertIn("alfalah", payload["favorite_sources"])

    def test_ics_endpoint_returns_calendar_payload(self):
        sample = next((e for e in safar_custom_app.EVENTS_CACHE if e.get("event_uid")), None)
        self.assertIsNotNone(sample)
        res = self.client.get(f"/api/events/{sample['event_uid']}/ics")
        self.assertEqual(res.status_code, 200)
        self.assertIn("text/calendar", res.headers.get("Content-Type", ""))
        self.assertIn("BEGIN:VCALENDAR", res.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
