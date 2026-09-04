package ai.workpilot.sample

import android.os.Bundle
import android.view.Gravity
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * One screen with one legible string.
 *
 * The string is the point: a screenshot of a blank activity proves the APK
 * installed, and nothing more. Text that a human can read in the artifact
 * proves the app actually drew.
 */
class MainActivity : AppCompatActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(
			TextView(this).apply {
				text = getString(R.string.on_screen)
				textSize = 28f
				gravity = Gravity.CENTER
			},
		)
	}
}
