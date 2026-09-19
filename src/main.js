import * as THREE from 'three'
import './style.css'

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.set(0, 0.15, 6)

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setAnimationLoop(animate)
document.querySelector('#app').append(renderer.domElement)

const pyramid = new THREE.Mesh(
  new THREE.ConeGeometry(1.6, 2.7, 4),
  new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    uniforms: {
      lightPosition: { value: new THREE.Vector3(-3, 4, 4) },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      void main() {
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 lightPosition;
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      void main() {
        vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
        vec3 lightDirection = normalize(lightPosition - vWorldPosition);
        float height = clamp((vWorldPosition.y + 1.35) / 2.7, 0.0, 1.0);
        vec3 gradient = mix(vec3(0.24, 0.03, 0.55), vec3(0.12, 0.9, 0.95), height);
        float fresnel = pow(1.0 - abs(dot(normalize(vNormal), viewDirection)), 2.5);
        float reflection = pow(max(dot(reflect(-lightDirection, normalize(vNormal)), viewDirection), 0.0), 18.0);
        gl_FragColor = vec4(gradient + reflection * vec3(1.0, 0.87, 0.96), 0.36 + fresnel * 0.4);
      }
    `,
  }),
)
scene.add(pyramid)

const glow = new THREE.Mesh(
  new THREE.SphereGeometry(0.45, 32, 32),
  new THREE.MeshBasicMaterial({ color: 0xffd9f2, transparent: true, opacity: 0.16 }),
)
glow.position.set(-2.2, 2.3, 1)
scene.add(glow)

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

function animate(time) {
  pyramid.rotation.y = time * 0.00032
  pyramid.rotation.x = Math.sin(time * 0.0002) * 0.15
  glow.scale.setScalar(1 + Math.sin(time * 0.002) * 0.08)
  renderer.render(scene, camera)
}

window.addEventListener('resize', resize)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'))
}
