---
title: "Real-time Evaporation Modeling with an IoT Sensor Platform"
collection: teaching
link: "https://github.com/xiaozh26/Urban-Water-Monitoring-RPi"
date: 2024
---
This project is the technical implementation of a prototype IoT system designed for complex environmental data acquisition and real-time analysis. The primary engineering challenge was to successfully integrate multiple, disparate hardware protocols on a single Raspberry Pi, creating a stable platform capable of continuous field operation.

The system's Python application is built to simultaneously manage and poll data from:

I2C Bus: Interfaces with an AHT20 (temperature/humidity) and BMP280 (barometric pressure) sensor.

GPIO: Actively manages the trigger/echo timing sequence for an HC-SR04 ultrasonic sensor to measure water level.

Modbus-RTU (RS485): Handles serial communication with a ZTS-3000-FSJT-N01 industrial anemometer. This includes building Modbus command frames and implementing crc16 checks to ensure data integrity.

The application architecture moves beyond simple data logging. It functions as a real-time analytics engine by:

Fusing the validated data from all sensors.

Executing the FAO Penman-Monteith scientific model on every loop to calculate the precise water evaporation rate.

Visualizing all raw sensor data and the final calculated result on a live matplotlib dashboard.

This platform served as the engineering proof-of-concept and data-acquisition system for my research paper, Upgrading Urban Water Storage System (arXiv:2308.08553).
