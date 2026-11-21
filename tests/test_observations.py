import struct
import json
import unittest

import cv2
import numpy as np

from aeromind.observations import ImageService, KeyframeMap, displacement, parse_packet, track_regions
from aeromind.vision import Reading


class EmptyPanel:
    def inspect(self, _image):
        return [Reading(17, "available", .98, ((20,20),(30,20),(30,30),(20,30)))]


def packet(stream, frame, secs, level=4):
    w,h=96,72
    meta={"stream":stream,"id":frame,"sim_time":secs,"fov":60,"width":w,"height":h,
          "level":level,"station":17,"camera_basis":np.eye(3).flatten().tolist()}
    encoded=json.dumps(meta).encode()
    return struct.pack("<I",len(encoded))+encoded+bytes(w*h*4)+np.full((h,w),400,"<u2").tobytes()


class ObservationTests(unittest.TestCase):
    def test_clone_restores_pending_visual_confirmation(self):
        s=ImageService(EmptyPanel())
        a=s.process(packet("A",1,.1))
        self.assertEqual(a["handoff"]["state"],"wait")
        self.assertEqual(s.fork("A","B"),{"last_frame":1,"sim_time":.1})
        b=s.process(packet("B",2,.2))
        a=s.process(packet("A",2,.2))
        self.assertEqual(a["handoff"],b["handoff"])
        self.assertEqual(a["handoff"]["state"],"ready")
        self.assertAlmostEqual(a["readings"][0]["panel_relative_m"][2],-4)
        with self.assertRaises(ValueError):
            s.process(packet("B",2,.2))

    def test_level_one_keeps_range_protection_without_visual_recognition(self):
        r=ImageService(EmptyPanel()).process(packet("A",1,.1,level=1))
        self.assertEqual(r["readings"],[])
        self.assertEqual(r["sector_m"],[4]*5)
        self.assertIsNone(r["translation_m"])

    def test_range_pixels_stay_paired_with_geometry_after_invalid_depth_is_removed(self):
        raw = bytearray(packet("range", 1, .1, level=1))
        offset = 4 + struct.unpack_from("<I", raw)[0] + 96*72*4
        depth = np.frombuffer(raw, "<u2", offset=offset).reshape(72, 96)
        depth[:, :48] = 0
        depth[:, 72:] = 9100
        result = ImageService(EmptyPanel()).process(raw)
        pixels = np.asarray(result["ray_pixels_px"])
        self.assertGreater(len(pixels), 2)
        self.assertTrue(np.all((pixels[:, 0] >= 48) & (pixels[:, 0] < 72)))
        focal = 36 / np.tan(np.deg2rad(30))
        expected = np.column_stack(((pixels[:, 0]-47.5)*4/focal, (35.5-pixels[:, 1])*4/focal, np.full(len(pixels), -4)))
        np.testing.assert_allclose(result["rays_world_relative_m"], expected, atol=.0051)

    def test_rgbd_odometry_recovers_translation_from_pixel_motion(self):
        rng=np.random.default_rng(42)
        gray=cv2.GaussianBlur(rng.integers(0,255,(120,160),np.uint8),(3,3),0)
        new=cv2.warpAffine(gray,np.float32([[1,0,-3],[0,1,0]]),(160,120))
        depth=np.full(gray.shape,4,np.float32)
        delta,count,error=displacement((gray,depth,np.eye(3),100),new,depth,np.eye(3),100,.12)
        self.assertGreater(count,25)
        self.assertLess(error,.04)
        np.testing.assert_allclose(delta,[.12,0,0],atol=.015)

    def test_truncated_packet_cannot_produce_depth(self):
        with self.assertRaises(ValueError):
            parse_packet(packet("A",1,.1)[:-4])

    def test_revisit_recognizes_old_rgbd_keyframe(self):
        image=np.random.default_rng(46).integers(0,255,(180,320),np.uint8)
        depth=np.full(image.shape,7,np.float32)
        landmarks=KeyframeMap()
        match,added=landmarks.update(image,depth,np.eye(3),160,3,.4)
        self.assertTrue(added)
        self.assertIsNone(match)
        match,_=landmarks.update(image.copy(),depth,np.eye(3),160,114,15)
        self.assertEqual(match["frame"],3)
        self.assertGreater(match["inliers"],20)
        np.testing.assert_allclose(match["translation_m"],(0,0,0),atol=.002)

    def test_semantic_tracks_measure_relative_approach(self):
        old=[{"label":"construction","center_uv":[.4,.5],"range_m":8}]
        n=track_regions(old,[],0,1)
        new=[{"label":"construction","center_uv":[.44,.5],"range_m":7.4}]
        next_n=track_regions(new,old,n,1.2)
        self.assertEqual(n,next_n)
        self.assertEqual(new[0]["track"],old[0]["track"])
        self.assertLess(new[0]["range_rate_m_s"],0)
        self.assertGreater(new[0]["predicted_uv_035s"][0],.44)
