import * as THREE from 'three'
import {
  DEFAULT_SETTINGS,
  createSettingsSnapshot,
} from '../app/settings.js'

const FALLBACK_SETTINGS = createSettingsSnapshot(DEFAULT_SETTINGS, false)

export function mountPrototypeScene(host, { settingsController } = {}) {
  if (host === null || typeof host !== 'object' || typeof host.append !== 'function') {
    throw new TypeError('Prototype scene host must support append')
  }

  const initialSettings = settingsController?.getSnapshot() ?? FALLBACK_SETTINGS
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
  camera.position.set(0, 0.15, 6)

  const renderer = new THREE.WebGLRenderer({
    antialias: initialSettings.quality !== 'low',
    alpha: true,
  })
  renderer.domElement.setAttribute('aria-hidden', 'true')
  host.append(renderer.domElement)

  const pyramidGeometry = new THREE.ConeGeometry(1.6, 2.7, 4)
  const pyramidMaterial = new THREE.ShaderMaterial({
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
  })
  const pyramid = new THREE.Mesh(pyramidGeometry, pyramidMaterial)
  scene.add(pyramid)

  const glowDetail = {
    low: 16,
    balanced: 24,
    high: 32,
  }[initialSettings.quality]
  const glowGeometry = new THREE.SphereGeometry(0.45, glowDetail, glowDetail)
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffd9f2,
    transparent: true,
    opacity: 0.16,
  })
  const glow = new THREE.Mesh(glowGeometry, glowMaterial)
  glow.position.set(-2.2, 2.3, 1)
  scene.add(glow)

  let currentSettings = initialSettings
  let animationTime = 0
  let previousTime = null

  function renderCurrentFrame() {
    pyramid.rotation.y = animationTime * 0.00032
    pyramid.rotation.x = Math.sin(animationTime * 0.0002) * 0.15
    glow.scale.setScalar(1 + Math.sin(animationTime * 0.002) * 0.08)
    renderer.render(scene, camera)
  }

  function resize() {
    const width = Math.max(1, host.clientWidth || window.innerWidth)
    const height = Math.max(1, host.clientHeight || window.innerHeight)
    const devicePixelRatio = Number.isFinite(window.devicePixelRatio)
      && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1
    renderer.setPixelRatio(Math.min(devicePixelRatio, currentSettings.renderScaleCap))
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height)
    if (currentSettings.reducedMotion) renderCurrentFrame()
  }

  function animate(time) {
    if (previousTime !== null) {
      animationTime += Math.max(0, time - previousTime) * currentSettings.animationSpeed
    }
    previousTime = time
    renderCurrentFrame()
  }

  function applySettings(settings) {
    currentSettings = settings
    previousTime = null
    resize()
    if (settings.reducedMotion) {
      renderer.setAnimationLoop(null)
      renderCurrentFrame()
    } else {
      renderer.setAnimationLoop(animate)
    }
  }

  resize()
  window.addEventListener('resize', resize)
  const unsubscribeSettings = settingsController?.subscribe(applySettings)
  if (!unsubscribeSettings) applySettings(FALLBACK_SETTINGS)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    renderer.setAnimationLoop(null)
    window.removeEventListener('resize', resize)
    unsubscribeSettings?.()
    pyramidGeometry.dispose()
    pyramidMaterial.dispose()
    glowGeometry.dispose()
    glowMaterial.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}
