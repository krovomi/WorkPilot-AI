plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

android {
	namespace = "ai.workpilot.sample"
	compileSdk = 35

	defaultConfig {
		applicationId = "ai.workpilot.sample"
		minSdk = 24
		targetSdk = 35
		versionCode = 1
		versionName = "1.0"
	}

	buildTypes {
		release {
			isMinifyEnabled = false
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	kotlinOptions {
		jvmTarget = "17"
	}
}

dependencies {
	implementation("androidx.appcompat:appcompat:1.7.0")
}
