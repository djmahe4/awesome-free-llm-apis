"""
yolo_nn_engine.py - Backward-compatible forwarder module.
Delegates all neural network operations to torch_nn_engine.py.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from torch_nn_engine import *

if __name__ == '__main__':
    main()
