"""Run the exported classroom networks with OpenCV DNN on an ordinary CPU."""

import threading

import cv2
import numpy as np

from .panels import PanelReader, Reading
from .regions import SIZE, has_texture, region_geometry
from .stations import LABELS


class OpenCVNetwork:
    def __init__(self, path):
        self.net=cv2.dnn.readNetFromONNX(str(path))
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self.lock=threading.Lock()

    def predict(self, batch):
        with self.lock:
            self.net.setInput(np.ascontiguousarray(batch,dtype=np.float32))
            return self.net.forward().copy()

    def probabilities(self, batch):
        logits=self.predict(batch)
        weights=np.exp(logits-logits.max(axis=1,keepdims=True))
        return weights/weights.sum(axis=1,keepdims=True)


class PortablePanels:
    def __init__(self, path):
        self.network=OpenCVNetwork(path)
        self.reader=PanelReader()

    def inspect(self, bgr, *, model_inputs=None):
        readings=[]
        for station,tile,quad in self.reader.patches(bgr, model_inputs):
            probs=self.network.probabilities(tile[None,None].astype(np.float32)/255)[0]
            index=int(probs.argmax())
            readings.append(Reading(station,LABELS[index],float(probs[index]),tuple(tuple(map(float,p)) for p in quad)))
        return readings


class PortableSegments:
    def __init__(self, path):
        self.network=OpenCVNetwork(path)

    def inspect(self, bgr, depth):
        if not has_texture(bgr):
            return []
        small=cv2.resize(bgr,SIZE,interpolation=cv2.INTER_AREA)
        batch=cv2.dnn.blobFromImage(small,1/255,swapRB=True)
        return region_geometry(self.network.probabilities(batch)[0],depth)
