// --- CONFIGURATION ---
const hasWorkExperience = true; 
const hasResearchExperience = false;

// --- TERM TRACKER LOGIC ---
function renderTerms() {
    const terms = [
        { name: "Fall 2025", start: new Date("2025-08-01"), end: new Date("2025-12-31") },
        { name: "Spring 2026", start: new Date("2026-01-01"), end: new Date("2026-05-31") },
        { name: "Fall 2026", start: new Date("2026-08-01"), end: new Date("2026-12-31") },
        { name: "Spring 2027", start: new Date("2027-01-01"), end: new Date("2027-05-31") },
        { name: "Fall 2027", start: new Date("2027-08-01"), end: new Date("2027-12-31") },
        { name: "Spring 2028", start: new Date("2028-01-01"), end: new Date("2028-05-31") }
    ];

    const now = new Date();
    const container = document.getElementById('term-list');
    if(!container) return;

    container.innerHTML = terms.map(term => {
        let styleClass = "text-slate-500"; // Future/Default
        
        if (now > term.end) {
            // Past (Dimmed)
            styleClass = "text-slate-200 opacity-40 decoration-slate-800"; 
        } else if (now >= term.start && now <= term.end) {
            // Current (Highlighted)
            styleClass = "text-blue-400 font-bold bg-blue-500/10 px-2 rounded border border-blue-500/20 shadow-[0_0_15px_-3px_rgba(59,130,246,0.3)]";
        } else {
            // Future
            styleClass = "text-slate-400 opacity-80";
        }

        return `<div class="text-[10px] mono uppercase tracking-wide ${styleClass} py-1 text-center transition-all flex items-center justify-center whitespace-nowrap">${term.name}</div>`;
    }).join('');
}

// --- 3D VESSEL SIMULATION ---
let scene, camera, renderer, raycaster, mouse, vessel, waterPlane, waypointMarker;
let obstacles = [], rays = [], sensorRaycaster, ducks = [];
let state = "IDLE";
let boatPose = { x: -8, z: 8, th: 0, v: 0 };
let target = { x: -8, z: 8 };

function initVesselDemo() {
    const container = document.getElementById('vessel-canvas-container');
    if (!container) return;
    const rect = container.getBoundingClientRect();

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, rect.width / rect.height, 0.1, 1000);
    camera.position.set(0, 18, 22);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(rect.width, rect.height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    raycaster = new THREE.Raycaster();
    sensorRaycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(10, 20, 10);
    scene.add(sun);

    // Water Plane (Click Detector)
    const waterGeo = new THREE.PlaneGeometry(30, 30);
    const waterMat = new THREE.MeshPhongMaterial({ color: 0x0f172a, transparent: true, opacity: 0.8 });
    waterPlane = new THREE.Mesh(waterGeo, waterMat);
    waterPlane.rotation.x = -Math.PI / 2;
    scene.add(waterPlane);

    const grid = new THREE.GridHelper(30, 30, 0x1e293b, 0x1e293b);
    scene.add(grid);

    // Waypoint Marker
    const wayGeo = new THREE.RingGeometry(0.4, 0.5, 32);
    const wayMat = new THREE.MeshBasicMaterial({color: 0x3b82f6, side: THREE.DoubleSide});
    waypointMarker = new THREE.Mesh(wayGeo, wayMat);
    waypointMarker.rotation.x = -Math.PI/2;
    waypointMarker.visible = false;
    scene.add(waypointMarker);

    // Vessel Model
    const boatGroup = new THREE.Group();
    const hullGeo = new THREE.BoxGeometry(1.2, 0.4, 2.5);
    const hullMat = new THREE.MeshPhongMaterial({ color: 0xf1f5f9 });
    const hull = new THREE.Mesh(hullGeo, hullMat);
    boatGroup.add(hull);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 0.8), new THREE.MeshPhongMaterial({color: 0x3b82f6}));
    cabin.position.set(0, 0.4, 0);
    boatGroup.add(cabin);

    vessel = boatGroup;
    scene.add(vessel);

    // Confidence Radius
    const conf = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.3, 32), new THREE.MeshBasicMaterial({color: 0x3b82f6, transparent: true, opacity: 0.2, side: THREE.DoubleSide}));
    conf.rotation.x = -Math.PI/2;
    vessel.add(conf);

    // Stationary Obstacles (Rocks)
    const rockMat = new THREE.MeshPhongMaterial({color: 0x64748b, flatShading: true});
    const positions = [[5, 5], [-5, -5], [8, -2], [-2, 4], [0, -8], [3, -4], [-6, 2]];
    
    positions.forEach(pos => {
        const geo = new THREE.IcosahedronGeometry(0.6 + Math.random()*0.4, 0);
        const rock = new THREE.Mesh(geo, rockMat);
        rock.position.set(pos[0], 0.3, pos[1]);
        rock.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
        scene.add(rock);
        obstacles.push(rock);
    });

    // Moving Obstacles (Ducks)
    const duckGroup = new THREE.Group();
    const bodyGeo = new THREE.SphereGeometry(0.4, 8, 8);
    const bodyMat = new THREE.MeshPhongMaterial({color: 0xfacc15}); // Yellow
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    
    const headGeo = new THREE.SphereGeometry(0.25, 8, 8);
    const head = new THREE.Mesh(headGeo, bodyMat);
    head.position.set(0.3, 0.3, 0);
    
    const beakGeo = new THREE.ConeGeometry(0.1, 0.2, 8);
    const beakMat = new THREE.MeshPhongMaterial({color: 0xf97316}); // Orange
    const beak = new THREE.Mesh(beakGeo, beakMat);
    beak.rotation.z = -Math.PI/2;
    beak.position.set(0.5, 0.3, 0);

    duckGroup.add(body, head, beak);
    
    // Create a few ducks
    for(let i=0; i<3; i++) {
        const duck = duckGroup.clone();
        duck.position.set((Math.random()-0.5)*15, 0.3, (Math.random()-0.5)*15);
        duck.userData = { 
            velocity: new THREE.Vector3((Math.random()-0.5)*0.05, 0, (Math.random()-0.5)*0.05),
            phase: Math.random() * Math.PI * 2 
        };
        scene.add(duck);
        obstacles.push(duck); // Add to obstacles for avoidance/sensing
        ducks.push(duck); // Keep track for animation
    }

    // Visual Rays (Always Visible)
    for(let i=0; i<4; i++) {
        // Line geometry for ray visual (length 1, will scale)
        const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,1)]);
        const rayMat = new THREE.LineBasicMaterial({color: 0xef4444, transparent: true, opacity: 0.4});
        const ray = new THREE.Line(rayGeo, rayMat);
        vessel.add(ray);
        rays.push(ray);
    }

    container.addEventListener('click', onWaterClick);
    animate();
}

function onWaterClick(event) {
    // Ensure clicks on UI buttons don't trigger movement
    if (event.target !== renderer.domElement) return;

    const container = document.getElementById('vessel-canvas-container');
    const rect = container.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(waterPlane);

    if (intersects.length > 0) {
        target.x = intersects[0].point.x;
        target.z = intersects[0].point.z;
        
        waypointMarker.position.set(target.x, 0.05, target.z);
        waypointMarker.visible = true;
        
        state = "MISSION";
        document.getElementById('tel-stat').textContent = "MISSION";
        document.getElementById('tel-stat').className = "text-blue-400";
    }
}

function animate() {
    requestAnimationFrame(animate);
    
    // Update Ducks
    ducks.forEach(duck => {
        duck.position.add(duck.userData.velocity);
        // Simple bounds check/bounce
        if(Math.abs(duck.position.x) > 14) duck.userData.velocity.x *= -1;
        if(Math.abs(duck.position.z) > 14) duck.userData.velocity.z *= -1;
        
        // Bobbing
        duck.position.y = 0.3 + Math.sin(Date.now() * 0.005 + duck.userData.phase) * 0.05;
        
        // Face direction
        const angle = Math.atan2(duck.userData.velocity.z, duck.userData.velocity.x); 
        duck.rotation.y = -angle; 
    });

    if (state !== "IDLE") {
        // POTENTIAL FIELD NAVIGATION
        let attractiveX = target.x - boatPose.x;
        let attractiveZ = target.z - boatPose.z;
        let distToTarget = Math.sqrt(attractiveX**2 + attractiveZ**2);
        
        if (distToTarget > 0) {
            attractiveX /= distToTarget;
            attractiveZ /= distToTarget;
        }

        let repulsiveX = 0, repulsiveZ = 0;
        obstacles.forEach(obs => {
            let dx = boatPose.x - obs.position.x;
            let dz = boatPose.z - obs.position.z;
            let dist = Math.sqrt(dx*dx + dz*dz);
            if (dist < 3) {
                let force = (1.0 / dist) - (1.0 / 3.0);
                repulsiveX += (dx / dist) * force * 5;
                repulsiveZ += (dz / dist) * force * 5;
            }
        });

        let resX = attractiveX + repulsiveX;
        let resZ = attractiveZ + repulsiveZ;

        if (distToTarget > 0.3) {
            const desiredHeading = Math.atan2(resX, resZ);
            let angleDiff = desiredHeading - boatPose.th;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

            boatPose.th += angleDiff * 0.08;
            boatPose.v = 0.07;
        } else {
            boatPose.v = 0;
            if (state === "RTH") {
                state = "IDLE";
                document.getElementById('tel-stat').textContent = "IDLE";
                document.getElementById('tel-stat').className = "text-emerald-400";
                waypointMarker.visible = false;
            }
        }

        boatPose.x += Math.sin(boatPose.th) * boatPose.v;
        boatPose.z += Math.cos(boatPose.th) * boatPose.v;
    }

    vessel.position.set(boatPose.x, 0.25, boatPose.z);
    vessel.rotation.y = boatPose.th;

    // UI & Sensor Raycasting Updates
    document.getElementById('tel-x').textContent = boatPose.x.toFixed(2);
    document.getElementById('tel-y').textContent = boatPose.z.toFixed(2);
    document.getElementById('tel-th').textContent = (boatPose.th * 180 / Math.PI).toFixed(1) + "°";

    // Raycasting logic
    const sensorOffsets = [0, -Math.PI/2, Math.PI, Math.PI/2]; // Front, Right, Back, Left relative to heading
    const maxRange = 5; // meters

    sensorOffsets.forEach((offset, i) => {
        const angle = boatPose.th + offset;
        const dir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle)).normalize();
        const origin = new THREE.Vector3(boatPose.x, 0.5, boatPose.z);
        
        sensorRaycaster.set(origin, dir);
        const intersects = sensorRaycaster.intersectObjects(obstacles);
        
        let dist = maxRange * 1000; // mm
        if (intersects.length > 0) {
            const d = intersects[0].distance;
            if(d < maxRange) dist = Math.floor(d * 1000);
        }
        
        // Update UI Text
        document.getElementById(`s${i+1}-val`).textContent = dist;

        // Update Visual Ray
        const rayLine = rays[i];
        rayLine.material.opacity = 0.4; // Always visible
        
        // Align ray line to sensor direction locally
        if(i===0) rayLine.rotation.set(0,0,0);
        if(i===1) rayLine.rotation.set(0, -Math.PI/2, 0);
        if(i===2) rayLine.rotation.set(0, Math.PI, 0);
        if(i===3) rayLine.rotation.set(0, Math.PI/2, 0);

        const scaleLen = (dist / 1000) / 1; // Base length is 1 unit
        rayLine.scale.z = dist/1000; 
        rayLine.position.y = 0.1;
    });

    renderer.render(scene, camera);
}

function triggerRTH() {
    state = "RTH";
    target = { x: -8, z: 8 };
    waypointMarker.position.set(target.x, 0.05, target.z);
    waypointMarker.visible = true;
    document.getElementById('tel-stat').textContent = "RTH";
    document.getElementById('tel-stat').className = "text-orange-400";
}

// --- THERMAL DEMO LOGIC ---
let thState = {
    tServer: 60,
    tWater: 30,
    mode: 'RECOVERY'
};

function updateThermalDemo() {
    // Physics Constants
    const HEAT_RATE = 0.05;
    const WATER_HEAT_RATE = 0.03;
    const WATER_COOL_RATE = 0.01;
    const TARGET_COOL_TEMP = 65;
    const COOLING_STRENGTH = 0.1;

    // Logic
    if (thState.mode === 'RECOVERY') {
        // Server heats up
        thState.tServer += HEAT_RATE;
        // Water heats up (absorbing server heat)
        thState.tWater += WATER_HEAT_RATE;

        // Trigger switch to Cooling if Water gets too hot
        if (thState.tWater >= 45) {
            thState.mode = 'COOLING';
        }
    } else {
        // COOLING (Radiator Active)
        // Server moves towards target temp (65)
        // If it's hotter than 65, it cools down fast.
        if (thState.tServer > TARGET_COOL_TEMP) {
            thState.tServer -= COOLING_STRENGTH;
        } else {
            // Small fluctuation around target
            thState.tServer += (Math.random() - 0.5) * 0.1; 
        }

        // Water cools down slowly
        thState.tWater -= WATER_COOL_RATE;

        // Trigger switch back to Recovery if Water is cool enough
        if (thState.tWater <= 35) { // Hysteresis
            thState.mode = 'RECOVERY';
        }
    }

    // Update DOM
    document.getElementById('val-t3').textContent = thState.tServer.toFixed(1) + '°C';
    document.getElementById('val-t1').textContent = thState.tWater.toFixed(1) + '°C';
    
    const modeText = document.getElementById('sys-mode');
    const pipeRadIn = document.getElementById('pipe-rad-in');
    const pipeRadOut = document.getElementById('pipe-rad-out');
    const pipeTankIn = document.getElementById('pipe-tank-in');
    const pipeTankCoil = document.getElementById('pipe-tank-coil');
    const pipeTankOut = document.getElementById('pipe-tank-out');

    if (thState.mode === 'RECOVERY') {
        modeText.textContent = "HEAT RECOVERY";
        modeText.style.fill = "#34d399"; 
        
        // Show Tank path
        pipeTankIn.classList.remove('hidden-flow');
        pipeTankCoil.classList.remove('hidden-flow');
        pipeTankOut.classList.remove('hidden-flow');
        // Hide Radiator path
        pipeRadIn.classList.add('hidden-flow');
        pipeRadOut.classList.add('hidden-flow');
    } else {
        modeText.textContent = "RADIATOR COOLING";
        modeText.style.fill = "#60a5fa"; 
        
        // Hide Tank path
        pipeTankIn.classList.add('hidden-flow');
        pipeTankCoil.classList.add('hidden-flow');
        pipeTankOut.classList.add('hidden-flow');
        // Show Radiator path
        pipeRadIn.classList.remove('hidden-flow');
        pipeRadOut.classList.remove('hidden-flow');
    }

    requestAnimationFrame(updateThermalDemo);
}

// --- RENDER LOGIC ---
function initializeContent() {
    const expContainer = document.getElementById('experience-container');
    const resContainer = document.getElementById('research-container');

    if (hasWorkExperience) {
        expContainer.innerHTML = `
            <div class="glass-card p-6 rounded-2xl flex gap-6">
                <div class="hidden sm:block w-14 h-14 rounded-lg bg-white p-2 flex-shrink-0 flex items-center justify-center">
                    <img src="hkn.png" alt="HKN Logo" class="w-full h-full object-contain" onerror="this.src='https://hkn.org/wp-content/uploads/2019/03/HKN-Seal-Color.png'">
                </div>
                <div class="flex-grow">
                    <div class="flex flex-col sm:flex-row sm:justify-between sm:items-start mb-2">
                        <div>
                            <h3 class="text-lg font-bold text-slate-100 leading-tight">Service Officer</h3>
                            <p class="text-blue-400 font-medium">Eta Kappa Nu (HKN), UC Berkeley</p>
                        </div>
                        <span class="text-sm mono text-slate-500 mt-1 sm:mt-0">September 2025 — Present</span>
                    </div>
                    <div class="space-y-2 text-slate-400 text-sm mb-4 leading-relaxed">
                        <p>• Organize, coordinate, and run community outreach and service events, promoting EECS education and engagement within the local student community.</p>
                        <p>• Develop and coordinate electrical engineering and computer science related workshops for local high school students.</p>
                        <p>• Lead and run weekly tutoring sessions for EECS coursework at UC Berkeley, supporting undergraduate students in core computer science and electrical engineering classes.</p>
                    </div>
                    <div class="flex flex-wrap gap-2">
                        <span class="skill-tag">Outreach</span>
                        <span class="skill-tag">Tutoring</span>
                        <span class="skill-tag">EECS Education</span>
                        <span class="skill-tag">Leadership</span>
                    </div>
                </div>
            </div>`;
    } else {
        expContainer.innerHTML = `<div class="glass-card p-12 rounded-2xl text-center border-dashed border-slate-700"><p class="text-slate-500 mono text-sm tracking-widest uppercase">Stay Tuned — Professional roles in progress</p></div>`;
    }

    if (hasResearchExperience) {
        resContainer.innerHTML = `<!-- Research placeholder -->`;
    } else {
        resContainer.innerHTML = `<div class="glass-card p-12 rounded-2xl text-center border-dashed border-slate-700"><p class="text-slate-500 mono text-sm tracking-widest uppercase">Stay Tuned — Research initiatives coming soon</p></div>`;
    }
    
    lucide.createIcons();
    setTimeout(initVesselDemo, 100);
    updateThermalDemo(); // Start thermal demo loop
    renderTerms(); // Initialize term tracker
}

function showSection(sectionId) {
    document.querySelectorAll('.view-section').forEach(section => section.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');
    if (window.innerWidth < 1024) { window.scrollTo({ top: 0, behavior: 'smooth' }); }
    
    if(sectionId === 'projects' && renderer) {
        const container = document.getElementById('vessel-canvas-container');
        const rect = container.getBoundingClientRect();
        renderer.setSize(rect.width, rect.height);
        camera.aspect = rect.width / rect.height;
        camera.updateProjectionMatrix();
    }
}

window.onload = initializeContent;