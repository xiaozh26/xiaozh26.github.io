---
title: "Real-time Evaporation Modeling with an IoT Sensor Platform"
collection: teaching
link: "https://github.com/xiaozh26/Urban-Water-Monitoring-RPi"
date: 2024
location: "Beijing, China"
excerpt: "This project is the technical implementation of a prototype IoT system for complex environmental data acquisition and real-time analysis, where the primary engineering challenge was integrating multiple, disparate hardware protocols on a single, stable Raspberry Pi platform. The system's Python application simultaneously manages and polls data from an I2C bus (interfacing with AHT20 temperature/humidity and BMP280 pressure sensors), GPIO (actively managing the trigger/echo timing for an HC-SR04 ultrasonic sensor), and Modbus-RTU (RS485) (handling serial communication and CRC16 checks for a ZTS-3000-FSJT-N01 anemometer). Moving beyond simple data logging, the application architecture functions as a real-time analytics engine by fusing the validated sensor data, executing the FAO Penman-Monteith scientific model on every loop to calculate the precise water evaporation rate, and visualizing all raw and calculated data on a live matplotlib dashboard. This platform served as the engineering proof-of-concept and data-acquisition system for my research paper, "Upgrading Urban Water Storage System" (arXiv:2308.08553)."
---

