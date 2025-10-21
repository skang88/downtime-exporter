pipeline {
    agent any // Or specify a node with Docker installed, e.g., agent { label 'docker' }

    environment {
        // Define a registry and image name. Change these to your actual registry and image name.
        REGISTRY = 'your-docker-registry' // e.g., 'docker.io/your-username' or your private registry
        IMAGE_NAME = 'downtime-exporter'
        IMAGE_TAG = "v1.0.${env.BUILD_NUMBER}"
    }

    stages {
        stage('Checkout') {
            steps {
                // Checkout the source code from your Git repository
                git 'https://github.com/skang88/downtime-exporter'
            }
        }

        stage('Build Docker Image') {
            steps {
                script {
                    echo "Building Docker image: ${IMAGE_NAME}:${IMAGE_TAG}"
                    // The docker.build command assumes you have Docker configured in Jenkins
                    def dockerImage = docker.build("${IMAGE_NAME}:${IMAGE_TAG}", '.')
                }
            }
        }

        stage('Push Docker Image') {
            steps {
                script {
                    // Log in to the Docker registry and push the image
                    // This requires credentials to be configured in Jenkins (e.g., with ID 'docker-registry-credentials')
                    docker.withRegistry("https://${REGISTRY}", 'docker-registry-credentials') {
                        echo "Pushing Docker image to ${REGISTRY}"
                        dockerImage.push()
                    }
                }
            }
        }

        stage('Deploy') {
            steps {
                // This is a placeholder for your deployment strategy.
                // You might use `sshagent` to SSH into a server and run the Docker container,
                // or use kubectl to apply a deployment in a Kubernetes cluster.
                echo "Deploying ${IMAGE_NAME}:${IMAGE_TAG}..."
                /*
                withCredentials([sshUserPrivateKey(credentialsId: 'your-ssh-credentials', keyFileVariable: 'SSH_KEY')]) {
                    sh '''
                        ssh -i $SSH_KEY user@your-server.com " \
                            docker pull ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG} && \
                            docker stop ${IMAGE_NAME} || true && \
                            docker rm ${IMAGE_NAME} || true && \
                            docker run -d --rm --name ${IMAGE_NAME} -p 9100:9100 \
                                -e DB_HOST=your_db_host \
                                -e DB_USER=your_db_user \
                                -e DB_PASSWORD=your_db_password \
                                -e DB_DATABASE=your_db_name \
                                ${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}
                        "
                    '''
                }
                */
            }
        }
    }

    post {
        always {
            // Clean up workspace or send notifications
            echo 'Pipeline finished.'
        }
    }
}
